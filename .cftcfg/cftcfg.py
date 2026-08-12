#!/usr/bin/env python3
"""cftcfg - Cloudflare Tunnel (cloudflared) configuration manager.

Modes:
    python cftcfg.py            interactive TUI
    python cftcfg.py gui        graphical interface (tkinter)
    python cftcfg.py cli ...    non-interactive CLI for scripting
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

APP_NAME = "cftcfg"
APP_VERSION = "1.0.0"
IS_WINDOWS = os.name == "nt"

try:
    import yaml

    YAML_OK = True
except ImportError:
    yaml = None
    YAML_OK = False

try:
    from rich.console import Console
    from rich.table import Table as RichTable

    RICH_OK = True
except ImportError:
    RICH_OK = False

try:
    import textual  # noqa: F401

    TEXTUAL_OK = True
except ImportError:
    TEXTUAL_OK = False

_CONSOLE = Console() if RICH_OK else None
_CONSOLE_ERR = Console(stderr=True) if RICH_OK else None

if IS_WINDOWS:
    for _stream in (sys.stdout, sys.stderr):
        if _stream is not None:
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def cprint(message: str = "", style: Optional[str] = None, err: bool = False) -> None:
    if _CONSOLE is not None:
        (_CONSOLE_ERR if err else _CONSOLE).print(message, style=style)
    else:
        print(message, file=sys.stderr if err else sys.stdout)


def emit_json(payload: Any) -> None:
    print(json.dumps(payload, indent=2))


def emit_error(message: str) -> None:
    cprint(f"error: {message}", style="bold red", err=True)


def emit_ok(message: str) -> None:
    cprint(message, style="green")


CATCH_ALL_LABEL = "<catch-all>"
HOSTNAME_RE = re.compile(
    r"^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$"
)
SERVICE_SCHEMES = ("http", "https", "tcp", "udp", "ssh", "rdp", "smb")


def validate_hostname(hostname: str) -> Optional[str]:
    if not hostname:
        return "hostname is required"
    if len(hostname) > 253:
        return "hostname is too long"
    if hostname == "localhost" or HOSTNAME_RE.match(hostname):
        return None
    return f"invalid hostname: {hostname!r}"


def validate_service(service: str) -> Optional[str]:
    if not service:
        return "service is required"
    if service in ("hello_world", "bastion"):
        return None
    if re.match(r"^http_status:[1-5]\d\d$", service):
        return None
    if service.startswith("unix:") or service.startswith("unix+tls:"):
        return None if len(service.split(":", 1)[1]) > 0 else "unix service requires a socket path"
    if "://" in service:
        scheme = service.split("://", 1)[0]
        if scheme in SERVICE_SCHEMES and service.split("://", 1)[1]:
            return None
    return (
        f"invalid service: {service!r} (expected e.g. http://127.0.0.1:3000, "
        "https://host, tcp://host:port, http_status:404, hello_world, bastion, unix:/path.sock)"
    )


def validate_path_prefix(path_prefix: str) -> Optional[str]:
    if not path_prefix:
        return None
    if not path_prefix.startswith("/"):
        return "path must start with '/'"
    if any(ch.isspace() for ch in path_prefix):
        return "path must not contain whitespace"
    return None


@dataclass
class IngressRule:
    hostname: Optional[str]
    service: str
    path: Optional[str] = None

    @property
    def is_catch_all(self) -> bool:
        return not self.hostname

    def display_hostname(self) -> str:
        return self.hostname or CATCH_ALL_LABEL


class ConfigError(Exception):
    pass


class TunnelConfig:
    """Mutable representation of a cloudflared configuration file."""

    def __init__(self, path: Path, raw: dict[str, Any]):
        self.path = path
        self.raw = raw

    @property
    def tunnel(self) -> Optional[str]:
        value = self.raw.get("tunnel")
        return str(value) if value is not None else None

    @property
    def credentials_file(self) -> Optional[str]:
        value = self.raw.get("credentials-file")
        return str(value) if value is not None else None

    def _ingress_raw(self) -> list[Any]:
        ingress = self.raw.get("ingress")
        if ingress is None:
            ingress = []
            self.raw["ingress"] = ingress
        if not isinstance(ingress, list):
            raise ConfigError("'ingress' must be a list of rules")
        return ingress

    def rules(self) -> list[IngressRule]:
        result = []
        for item in self._ingress_raw():
            if not isinstance(item, dict):
                raise ConfigError(f"ingress rule must be a mapping, got: {item!r}")
            hostname = item.get("hostname")
            result.append(
                IngressRule(
                    hostname=str(hostname) if hostname else None,
                    service=str(item.get("service", "")),
                    path=str(item["path"]) if item.get("path") else None,
                )
            )
        return result

    def _find_index(
        self,
        hostname: str,
        path: Optional[str] = None,
        exact_path: bool = False,
    ) -> Optional[int]:
        for idx, item in enumerate(self._ingress_raw()):
            if not isinstance(item, dict):
                continue
            item_host = str(item.get("hostname") or "")
            item_path = str(item["path"]) if item.get("path") else None
            if item_host == hostname:
                if exact_path:
                    if item_path == path:
                        return idx
                else:
                    if path is None or item_path == path:
                        return idx
        return None

    def _catch_all_index(self) -> Optional[int]:
        for idx, item in enumerate(self._ingress_raw()):
            if isinstance(item, dict) and not item.get("hostname"):
                return idx
        return None

    def add_rule(self, hostname: str, service: str, path: Optional[str] = None) -> None:
        for check, value in (
            (validate_hostname, hostname),
            (validate_service, service),
            (validate_path_prefix, path or ""),
        ):
            error = check(value)
            if error:
                raise ConfigError(error)
        if self._find_index(hostname, path, exact_path=True) is not None:
            raise ConfigError(f"a rule for {hostname!r} (path={path or '*'!r}) already exists")
        rule: dict[str, Any] = {"hostname": hostname, "service": service}
        if path:
            rule["path"] = path
        ingress = self._ingress_raw()
        catch_all = self._catch_all_index()
        if catch_all is not None and catch_all == len(ingress) - 1:
            ingress.insert(catch_all, rule)
        else:
            ingress.append(rule)

    def edit_rule(
        self,
        hostname: str,
        path: Optional[str] = None,
        new_hostname: Optional[str] = None,
        new_service: Optional[str] = None,
        new_path: Optional[str] = None,
    ) -> None:
        idx = self._find_index(hostname, path, exact_path=(path is not None))
        if idx is None:
            raise ConfigError(f"no rule found for hostname {hostname!r}")
        item = self._ingress_raw()[idx]
        target_hostname = new_hostname if new_hostname is not None else str(item.get("hostname", ""))
        target_service = new_service if new_service is not None else str(item.get("service", ""))
        if new_path is not None:
            target_path: Optional[str] = new_path or None
        else:
            target_path = str(item["path"]) if item.get("path") else None

        for check, value in (
            (validate_hostname, target_hostname),
            (validate_service, target_service),
            (validate_path_prefix, target_path or ""),
        ):
            error = check(value)
            if error:
                raise ConfigError(error)

        clash = self._find_index(target_hostname, target_path, exact_path=True)
        if clash is not None and clash != idx:
            raise ConfigError(
                f"another rule already matches {target_hostname!r} (path={target_path or '*'!r})"
            )

        item["hostname"] = target_hostname
        item["service"] = target_service
        if target_path:
            item["path"] = target_path
        else:
            item.pop("path", None)

    def remove_rule(self, hostname: str, path: Optional[str] = None) -> IngressRule:
        idx = self._find_index(hostname, path, exact_path=(path is not None))
        if idx is None:
            raise ConfigError(f"no rule found for hostname {hostname!r}")
        removed = self._ingress_raw().pop(idx)
        return IngressRule(
            hostname=str(removed.get("hostname") or "") or None,
            service=str(removed.get("service", "")),
            path=str(removed["path"]) if removed.get("path") else None,
        )

    def set_catch_all(self, service: str) -> None:
        error = validate_service(service)
        if error:
            raise ConfigError(error)
        ingress = self._ingress_raw()
        idx = self._catch_all_index()
        if idx is None:
            ingress.append({"service": service})
        else:
            if idx != len(ingress) - 1:
                raise ConfigError("catch-all rule is not the last ingress rule; fix the file manually")
            ingress[idx]["service"] = service
            ingress[idx].pop("hostname", None)
            ingress[idx].pop("path", None)

    def validate_structure(self) -> list[str]:
        errors: list[str] = []
        try:
            rules = self.rules()
        except ConfigError as exc:
            return [str(exc)]

        if not rules:
            errors.append("no ingress rules defined")
            return errors

        seen: set[tuple[str, str]] = set()
        for idx, rule in enumerate(rules):
            label = f"rule {idx + 1} ({rule.display_hostname()})"
            if rule.is_catch_all:
                if idx != len(rules) - 1:
                    errors.append(f"{label}: catch-all rule must be the last ingress rule")
            else:
                error = validate_hostname(rule.hostname or "")
                if error:
                    errors.append(f"{label}: {error}")
                key = (rule.hostname or "", rule.path or "")
                if key in seen:
                    errors.append(f"{label}: duplicate hostname/path combination")
                seen.add(key)

            error = validate_service(rule.service)
            if error:
                errors.append(f"{label}: {error}")
            error = validate_path_prefix(rule.path or "")
            if error:
                errors.append(f"{label}: {error}")

        if not rules[-1].is_catch_all:
            errors.append("last ingress rule should be a catch-all (service without hostname)")
        if not self.tunnel:
            errors.append("no 'tunnel' name/ID set at top level")
        return errors


def default_config_path() -> Path:
    return Path.home() / ".cloudflared" / "config.yml"


def find_config(explicit: Optional[str] = None, configured: Optional[str] = None) -> Optional[Path]:
    for candidate in (explicit, configured):
        if candidate:
            path = Path(candidate).expanduser()
            return path if path.exists() else None

    search_paths = [
        Path.cwd() / "config.yml",
        Path.cwd() / "config.yaml",
        Path.home() / ".cloudflared" / "config.yml",
        Path.home() / ".cloudflared" / "config.yaml",
    ]
    if not IS_WINDOWS:
        search_paths.extend([
            Path("/etc/cloudflared/config.yml"),
            Path("/etc/cloudflared/config.yaml"),
            Path("/usr/local/etc/cloudflared/config.yml"),
            Path("/usr/local/etc/cloudflared/config.yaml"),
        ])

    for path in search_paths:
        if path.exists():
            return path
    return None


def default_config_template(tunnel: str = "") -> str:
    return (
        f"tunnel: {tunnel or '<tunnel-name-or-id>'}\n"
        "credentials-file: <path-to-credentials.json>\n"
        "ingress:\n"
        "  # - hostname: app.example.com\n"
        "  #   service: http://127.0.0.1:3000\n"
        "  - service: http_status:404\n"
    )


class ConfigManager:
    def __init__(self, path: Path):
        self.path = Path(path)

    def exists(self) -> bool:
        return self.path.exists()

    def create_default(self, tunnel: str = "") -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            raise ConfigError(f"config already exists: {self.path}")
        self.path.write_text(default_config_template(tunnel), encoding="utf-8")

    def load(self) -> TunnelConfig:
        if not YAML_OK:
            raise ConfigError("PyYAML is not installed (pip install pyyaml)")
        if not self.path.exists():
            raise ConfigError(f"config file not found: {self.path}")
        try:
            text = self.path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"cannot read {self.path}: {exc}") from exc
        try:
            raw = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise ConfigError(f"invalid YAML in {self.path}: {exc}") from exc
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise ConfigError(f"top level of {self.path} must be a mapping")
        return TunnelConfig(self.path, raw)

    def backup(self) -> Path:
        if not self.path.exists():
            raise ConfigError(f"nothing to back up: {self.path} does not exist")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = self.path.with_name(f"{self.path.name}.bak.{stamp}")
        counter = 1
        while backup.exists():
            backup = self.path.with_name(f"{self.path.name}.bak.{stamp}.{counter}")
            counter += 1
        try:
            shutil.copy2(self.path, backup)
        except OSError as exc:
            raise ConfigError(f"backup failed: {exc}") from exc
        return backup

    def save(self, config: TunnelConfig, make_backup: bool = True) -> Optional[Path]:
        backup_path = self.backup() if (make_backup and self.path.exists()) else None
        try:
            text = yaml.safe_dump(
                config.raw,
                sort_keys=False,
                default_flow_style=False,
                allow_unicode=True,
                width=120,
            )
            self.path.write_text(text, encoding="utf-8")
        except (OSError, yaml.YAMLError) as exc:
            raise ConfigError(f"cannot write {self.path}: {exc}") from exc
        return backup_path

    def backups(self) -> list[Path]:
        if not self.path.parent.exists():
            return []
        return sorted(
            self.path.parent.glob(f"{self.path.name}.bak.*"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )

    def restore(self, backup: Path) -> Path:
        if not backup.exists():
            raise ConfigError(f"backup not found: {backup}")
        safety = self.backup() if self.path.exists() else None
        try:
            shutil.copy2(backup, self.path)
        except OSError as exc:
            raise ConfigError(f"restore failed: {exc}") from exc
        return safety if safety else backup


@dataclass
class Cloudflared:
    path: Optional[str] = None
    version: Optional[str] = None
    searched: list[str] = field(default_factory=list)

    @classmethod
    def locate(cls) -> "Cloudflared":
        searched: list[str] = []
        found = shutil.which("cloudflared")
        searched.append("PATH")
        if not found:
            home = Path.home()
            if IS_WINDOWS:
                candidates = [
                    home / ".cloudflared" / "cloudflared.exe",
                    Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "cloudflared" / "cloudflared.exe",
                    Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "cloudflared" / "cloudflared.exe",
                    Path(os.environ.get("LOCALAPPDATA", str(home))) / "cloudflared" / "cloudflared.exe",
                    Path("C:/cloudflared/cloudflared.exe"),
                ]
            else:
                candidates = [
                    home / ".cloudflared" / "cloudflared",
                    Path("/usr/local/bin/cloudflared"),
                    Path("/usr/bin/cloudflared"),
                    Path("/opt/cloudflared/cloudflared"),
                    Path("/snap/bin/cloudflared"),
                ]
            for candidate in candidates:
                searched.append(str(candidate))
                if candidate.exists():
                    found = str(candidate)
                    break
        instance = cls(path=found, searched=searched)
        if found:
            try:
                output = subprocess.run(
                    [found, "--version"], capture_output=True, text=True, timeout=15
                )
                raw_out = (output.stdout or output.stderr).strip()
                instance.version = raw_out.splitlines()[0] if raw_out else "unknown"
            except (OSError, subprocess.SubprocessError):
                instance.version = "unknown (failed to execute)"
        return instance

    @property
    def available(self) -> bool:
        return self.path is not None

    def validate_config(self, config_path: Path) -> tuple[bool, str]:
        if not self.available or self.path is None:
            return False, "cloudflared binary not found"
        try:
            result = subprocess.run(
                [self.path, "tunnel", "--config", str(config_path), "ingress", "validate"],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return False, f"failed to run cloudflared: {exc}"
        output = (result.stdout + result.stderr).strip()
        return result.returncode == 0, output or ("OK" if result.returncode == 0 else "validation failed")


@dataclass
class DockerInfo:
    container: str
    image: str
    compose_service: Optional[str] = None
    compose_project: Optional[str] = None
    compose_dir: Optional[str] = None
    started_at: Optional[str] = None


@dataclass
class PortInfo:
    port: int
    address: str
    pid: Optional[int]
    process_name: str
    exe_path: Optional[str] = None
    cmdline: Optional[str] = None
    cwd: Optional[str] = None
    docker: Optional[DockerInfo] = None

    @property
    def suggested_service(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def what(self) -> str:
        if self.docker:
            label = self.docker.compose_service or self.docker.container
            if self.docker.compose_project:
                return f"{label} (docker compose: {self.docker.compose_project})"
            return f"{self.docker.container} (docker: {self.docker.image})"
        return self.process_name or (f"pid {self.pid}" if self.pid else "unknown")

    def started_from(self) -> str:
        if self.docker:
            if self.docker.compose_dir:
                return self.docker.compose_dir
            return f"image {self.docker.image}"
        if self.cwd:
            return self.cwd
        if self.exe_path:
            return str(Path(self.exe_path).parent)
        return "unknown"

    def slug(self) -> str:
        base = ""
        if self.docker:
            base = self.docker.compose_service or self.docker.container
        elif self.process_name:
            base = self.process_name
        base = re.sub(r"\.(exe|bat|cmd|sh)$", "", base, flags=re.IGNORECASE)
        slug = re.sub(r"[^a-z0-9-]+", "-", base.lower()).strip("-")
        return slug or f"service-{self.port}"


def _docker_port_map() -> dict[int, DockerInfo]:
    docker = shutil.which("docker")
    if not docker:
        return {}
    try:
        listing = subprocess.run([docker, "ps", "-q"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return {}
    ids = listing.stdout.split()
    if listing.returncode != 0 or not ids:
        return {}
    try:
        inspected = subprocess.run(
            [docker, "inspect", *ids], capture_output=True, text=True, timeout=20
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if inspected.returncode != 0:
        return {}
    try:
        containers = json.loads(inspected.stdout)
    except json.JSONDecodeError:
        return {}

    result: dict[int, DockerInfo] = {}
    for container in containers if isinstance(containers, list) else []:
        try:
            labels = (container.get("Config") or {}).get("Labels") or {}
            info = DockerInfo(
                container=str(container.get("Name", "")).lstrip("/"),
                image=str((container.get("Config") or {}).get("Image", "?")),
                compose_service=labels.get("com.docker.compose.service"),
                compose_project=labels.get("com.docker.compose.project"),
                compose_dir=labels.get("com.docker.compose.project.working_dir"),
                started_at=(container.get("State") or {}).get("StartedAt"),
            )
            port_sources = [
                (container.get("HostConfig") or {}).get("PortBindings") or {},
                (container.get("NetworkSettings") or {}).get("Ports") or {},
            ]
            for ports in port_sources:
                for bindings in ports.values():
                    for binding in bindings or []:
                        host_port = str(binding.get("HostPort", ""))
                        if host_port.isdigit():
                            result[int(host_port)] = info
        except (AttributeError, TypeError):
            continue
    return result


def _scan_with_psutil() -> Optional[list[PortInfo]]:
    try:
        import psutil
    except ImportError:
        return None
    found: dict[int, PortInfo] = {}
    try:
        connections = psutil.net_connections(kind="tcp")
    except Exception:
        return None
    for conn in connections:
        if conn.status != "LISTEN" or not conn.laddr:
            continue
        port = conn.laddr.port
        address = conn.laddr.ip
        if port in found:
            if found[port].address not in ("0.0.0.0", "::") and address in ("0.0.0.0", "::"):
                found[port].address = address
            continue
        info = PortInfo(port=port, address=address, pid=conn.pid, process_name="")
        if conn.pid:
            try:
                proc = psutil.Process(conn.pid)
                info.process_name = proc.name()
                for attr, field_name in (("exe", "exe_path"), ("cwd", "cwd")):
                    try:
                        setattr(info, field_name, getattr(proc, attr)())
                    except Exception:
                        pass
                try:
                    info.cmdline = " ".join(proc.cmdline())
                except Exception:
                    pass
            except Exception:
                info.process_name = f"pid {conn.pid}"
        found[port] = info
    return sorted(found.values(), key=lambda p: p.port)


def _scan_with_netstat() -> list[PortInfo]:
    found: dict[int, PortInfo] = {}
    if IS_WINDOWS:
        try:
            output = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=30
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        for line in output.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[3].upper() == "LISTENING":
                local = parts[1]
                if ":" not in local:
                    continue
                address, _, port_text = local.rpartition(":")
                if not port_text.isdigit():
                    continue
                port = int(port_text)
                pid = int(parts[4]) if parts[4].isdigit() else None
                found.setdefault(port, PortInfo(port=port, address=address, pid=pid, process_name=""))
        pids = [str(p.pid) for p in found.values() if p.pid]
        if pids:
            try:
                ps_output = subprocess.run(
                    [
                        "powershell",
                        "-NoProfile",
                        "-Command",
                        "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,"
                        "ExecutablePath,CommandLine | ConvertTo-Json -Compress",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=60,
                ).stdout
                records = json.loads(ps_output) if ps_output.strip() else []
                if isinstance(records, dict):
                    records = [records]
                by_pid = {int(r["ProcessId"]): r for r in records if r.get("ProcessId")}
                for info in found.values():
                    if info.pid is not None and info.pid in by_pid:
                        record = by_pid[info.pid]
                        info.process_name = record.get("Name") or ""
                        info.exe_path = record.get("ExecutablePath")
                        info.cmdline = record.get("CommandLine")
            except (
                OSError,
                subprocess.SubprocessError,
                json.JSONDecodeError,
                ValueError,
                KeyError,
            ):
                pass
    else:
        try:
            output = subprocess.run(
                ["ss", "-tlnp"], capture_output=True, text=True, timeout=15
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return []
        for line in output.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[0].upper() == "LISTEN":
                local = parts[3]
                address, _, port_text = local.rpartition(":")
                if not port_text.isdigit():
                    continue
                pid = None
                name = ""
                match = re.search(r"pid=(\d+)", line)
                if match:
                    pid = int(match.group(1))
                match = re.search(r'"([^"]+)"', line)
                if match:
                    name = match.group(1)
                found.setdefault(
                    int(port_text),
                    PortInfo(port=int(port_text), address=address, pid=pid, process_name=name),
                )
    return sorted(found.values(), key=lambda p: p.port)


def scan_ports() -> list[PortInfo]:
    results = _scan_with_psutil()
    if results is None:
        results = _scan_with_netstat()
    docker_map = _docker_port_map()
    for info in results:
        if info.port in docker_map:
            info.docker = docker_map[info.port]
    return results


def suggest_hostname(info: PortInfo, config: Optional[TunnelConfig]) -> str:
    suffix = ""
    if config is not None:
        try:
            for rule in config.rules():
                if rule.hostname and not rule.hostname.startswith("*."):
                    parts = rule.hostname.split(".")
                    if len(parts) >= 2:
                        suffix = ".".join(parts[1:])
                        break
        except ConfigError:
            pass
    return f"{info.slug()}.{suffix or 'example.com'}"


def settings_dir() -> Path:
    if not IS_WINDOWS:
        base = os.environ.get("XDG_CONFIG_HOME")
        if base:
            return Path(base) / APP_NAME
    return Path.home() / f".{APP_NAME}"


class Settings:
    DEFAULTS = {
        "first_run_done": False,
        "path_integration_enabled": False,
        "config_path": None,
        "launcher_dir": None,
    }

    def __init__(self, path: Optional[Path] = None):
        self.path = path or (settings_dir() / "settings.json")
        self._data: dict[str, Any] = dict(self.DEFAULTS)
        self.load()

    def load(self) -> None:
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    self._data.update(data)
            except (OSError, json.JSONDecodeError):
                pass

    def save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self._data, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"cannot write settings {self.path}: {exc}") from exc

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self._data[key] = value

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self._data[key] = value


@dataclass
class PathStatus:
    installed: bool
    launcher_dir: Path
    on_path: bool
    details: str


def _broadcast_env_change() -> None:
    if not IS_WINDOWS:
        return
    try:
        import ctypes
        import ctypes.wintypes

        result = ctypes.wintypes.DWORD()
        ctypes.windll.user32.SendMessageTimeoutW(
            0xFFFF, 0x001A, 0, "Environment", 0x0002, 2000, ctypes.byref(result)
        )
    except Exception:
        pass


def _windows_user_path() -> tuple[str, int]:
    import winreg

    with winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        "Environment",
        0,
        winreg.KEY_READ | winreg.KEY_SET_VALUE,
    ) as key:
        try:
            value, value_type = winreg.QueryValueEx(key, "Path")
        except FileNotFoundError:
            value, value_type = "", winreg.REG_EXPAND_SZ
    return value, value_type


def _windows_write_user_path(value: str, value_type: int) -> None:
    import winreg

    with winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        "Environment",
        0,
        winreg.KEY_READ | winreg.KEY_SET_VALUE,
    ) as key:
        winreg.SetValueEx(key, "Path", 0, value_type, value)
    _broadcast_env_change()


def _norm_path_entry(entry: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.expandvars(entry.strip().strip('"'))))


def _dir_in_path_list(path_value: str, directory: Path) -> bool:
    target = _norm_path_entry(str(directory))
    entries = [e for e in path_value.split(";") if e.strip()]
    return any(_norm_path_entry(e) == target for e in entries)


class PathIntegrator:
    RC_MARKER = "# cftcfg PATH"

    def __init__(self, script_path: Path, settings: Settings):
        self.script_path = Path(script_path).resolve()
        self.settings = settings
        if IS_WINDOWS:
            self.default_dir = Path.home() / f".{APP_NAME}" / "bin"
        else:
            self.default_dir = Path.home() / ".local" / "bin"
        recorded = settings.get("launcher_dir")
        self.launcher_dir = Path(recorded) if recorded else self.default_dir

    def _candidate_dirs(self) -> list[Path]:
        dirs = [self.launcher_dir]
        if self.default_dir not in dirs:
            dirs.append(self.default_dir)
        return dirs

    def _windows_shims(self) -> dict[str, str]:
        python = sys.executable
        script = str(self.script_path)
        cmd = (
            "@echo off\r\n"
            "setlocal\r\n"
            f'if exist "{python}" (\r\n'
            f'    "{python}" "{script}" %*\r\n'
            ") else (\r\n"
            f'    python "{script}" %*\r\n'
            ")\r\n"
            "endlocal\r\n"
        )
        sh_python = python.replace("\\", "/")
        sh_script = script.replace("\\", "/")
        sh = (
            "#!/bin/sh\n"
            f'if [ -f "{sh_python}" ]; then\n'
            f'    exec "{sh_python}" "{sh_script}" "$@"\n'
            "else\n"
            f'    exec python "{sh_script}" "$@"\n'
            "fi\n"
        )
        return {"cftcfg.cmd": cmd, "cftcfg": sh}

    def _posix_shim_path(self) -> Path:
        return self.launcher_dir / APP_NAME

    def status(self) -> PathStatus:
        if IS_WINDOWS:
            try:
                value, _ = _windows_user_path()
            except OSError as exc:
                return PathStatus(False, self.launcher_dir, False, f"registry read failed: {exc}")
            on_path = _dir_in_path_list(value, self.launcher_dir)
            shim = self.launcher_dir / "cftcfg.cmd"
            installed = on_path and shim.exists()
            details = (
                f"launcher: {shim} ({'present' if shim.exists() else 'missing'}); "
                f"user PATH {'contains' if on_path else 'does not contain'} {self.launcher_dir}"
            )
            return PathStatus(installed, self.launcher_dir, on_path, details)
        shim = self._posix_shim_path()
        on_path_env = str(self.launcher_dir) in os.environ.get("PATH", "").split(os.pathsep)
        rc_files = self._posix_rc_files_touched()
        installed = shim.exists() and (on_path_env or bool(rc_files))
        details = (
            f"launcher: {shim} ({'present' if shim.exists() else 'missing'}); "
            f"{'on current PATH' if on_path_env else 'not on current PATH'}"
            + (f"; rc files: {', '.join(str(p) for p in rc_files)}" if rc_files else "")
        )
        return PathStatus(installed, self.launcher_dir, on_path_env or bool(rc_files), details)

    def _posix_rc_files_touched(self) -> list[Path]:
        touched = []
        for name in (".bashrc", ".zshrc", ".profile"):
            rc = Path.home() / name
            if rc.exists():
                try:
                    if self.RC_MARKER in rc.read_text(encoding="utf-8", errors="replace"):
                        touched.append(rc)
                except OSError:
                    pass
        return touched

    def enable(self) -> str:
        self.launcher_dir.mkdir(parents=True, exist_ok=True)
        messages: list[str] = []
        if IS_WINDOWS:
            for name, content in self._windows_shims().items():
                target = self.launcher_dir / name
                target.write_text(content, encoding="utf-8" if name.endswith(".sh") else "ascii")
                messages.append(f"wrote {target}")
            value, value_type = _windows_user_path()
            if _dir_in_path_list(value, self.launcher_dir):
                messages.append("user PATH already contains launcher directory")
            else:
                new_value = f"{value};{self.launcher_dir}" if value.strip() else str(self.launcher_dir)
                _windows_write_user_path(new_value, value_type)
                messages.append(f"added {self.launcher_dir} to user PATH (registry)")
        else:
            self.script_path.chmod(self.script_path.stat().st_mode | 0o111)
            usr_local = Path("/usr/local/bin")
            if usr_local.is_dir() and os.access(usr_local, os.W_OK):
                self.launcher_dir = usr_local
            else:
                self.launcher_dir.mkdir(parents=True, exist_ok=True)
            shim = self._posix_shim_path()
            if shim.is_symlink() or shim.exists():
                shim.unlink()
            shim.symlink_to(self.script_path)
            messages.append(f"symlinked {shim} -> {self.script_path}")
            if self.launcher_dir != usr_local:
                path_entries = os.environ.get("PATH", "").split(os.pathsep)
                if str(self.launcher_dir) not in path_entries:
                    line = f'export PATH="$HOME/.local/bin:$PATH"  {self.RC_MARKER}\n'
                    written = False
                    for name in (".bashrc", ".zshrc"):
                        rc = Path.home() / name
                        if rc.exists():
                            with rc.open("a", encoding="utf-8") as handle:
                                handle.write("\n" + line)
                            messages.append(f"appended PATH export to {rc}")
                            written = True
                    if not written:
                        rc = Path.home() / ".bashrc"
                        with rc.open("a", encoding="utf-8") as handle:
                            handle.write(line)
                        messages.append(f"created {rc} with PATH export")
        self.settings["path_integration_enabled"] = True
        self.settings["launcher_dir"] = str(self.launcher_dir)
        self.settings.save()
        return "; ".join(messages)

    def disable(self) -> str:
        messages: list[str] = []
        if IS_WINDOWS:
            for directory in self._candidate_dirs():
                for name in ("cftcfg.cmd", "cftcfg"):
                    target = directory / name
                    if target.exists():
                        target.unlink()
                        messages.append(f"removed {target}")
            value, value_type = _windows_user_path()
            stale = {_norm_path_entry(str(d)) for d in self._candidate_dirs()}
            kept = [e for e in value.split(";") if e.strip() and _norm_path_entry(e) not in stale]
            if kept != [e for e in value.split(";") if e.strip()]:
                _windows_write_user_path(";".join(kept), value_type)
                messages.append("removed launcher dir(s) from user PATH (registry)")
            for directory in self._candidate_dirs():
                try:
                    if directory.is_dir() and not any(directory.iterdir()):
                        directory.rmdir()
                        messages.append(f"removed empty directory {directory}")
                except OSError:
                    pass
        else:
            shim = self._posix_shim_path()
            if shim.is_symlink() or shim.exists():
                shim.unlink()
                messages.append(f"removed {shim}")
            for name in (".bashrc", ".zshrc", ".profile"):
                rc = Path.home() / name
                if rc.exists():
                    try:
                        lines = rc.read_text(encoding="utf-8", errors="replace").splitlines()
                    except OSError:
                        continue
                    kept = [line for line in lines if self.RC_MARKER not in line]
                    if kept != lines:
                        rc.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
                        messages.append(f"cleaned PATH export from {rc}")
        self.settings["path_integration_enabled"] = False
        self.settings.save()
        return "; ".join(messages) or "nothing to remove"


def render_rules_plain(rules: list[IngressRule]) -> str:
    if not rules:
        return "(no ingress rules)"
    header = f" {'#':<3} {'Hostname':<38} {'Service':<34} Path"
    lines = [header, " " + "-" * (len(header) - 1)]
    for idx, rule in enumerate(rules, 1):
        lines.append(f" {idx:<3} {rule.display_hostname():<38} {rule.service:<34} {rule.path or ''}")
    return "\n".join(lines)


def render_rules(rules: list[IngressRule]) -> None:
    if _CONSOLE is None:
        cprint(render_rules_plain(rules))
        return
    table = RichTable(show_lines=False)
    table.add_column("#", justify="right", style="dim")
    table.add_column("Hostname", style="cyan")
    table.add_column("Service", style="green")
    table.add_column("Path")
    for idx, rule in enumerate(rules, 1):
        table.add_row(str(idx), rule.display_hostname(), rule.service, rule.path or "")
    _CONSOLE.print(table)


def rules_as_json(manager: ConfigManager, config: TunnelConfig) -> str:
    payload = {
        "config": str(manager.path),
        "tunnel": config.tunnel,
        "credentials_file": config.credentials_file,
        "ingress": [
            {
                "hostname": r.hostname,
                "service": r.service,
                "path": r.path,
                "catch_all": r.is_catch_all,
            }
            for r in config.rules()
        ],
    }
    return json.dumps(payload, indent=2)


def _cli_manager(args: argparse.Namespace, settings: Settings) -> ConfigManager:
    config_arg = getattr(args, "config", None)
    path = find_config(config_arg, settings.get("config_path"))
    if path is None:
        hint = config_arg or settings.get("config_path")
        if hint:
            raise ConfigError(f"config file not found: {hint}")
        raise ConfigError(
            f"no cloudflared config found; use --config PATH or create one with '{APP_NAME} cli init'"
        )
    return ConfigManager(path)


def _cli_load(args: argparse.Namespace, settings: Settings) -> tuple[ConfigManager, TunnelConfig]:
    manager = _cli_manager(args, settings)
    return manager, manager.load()


def _cli_save(manager: ConfigManager, config: TunnelConfig) -> None:
    backup = manager.save(config, make_backup=True)
    if backup:
        cprint(f"backup: {backup}", style="dim")
    emit_ok(f"saved: {manager.path}")


def cmd_init(args: argparse.Namespace, settings: Settings) -> int:
    target_path = getattr(args, "path", None)
    target = Path(target_path).expanduser() if target_path else default_config_path()
    manager = ConfigManager(target)
    try:
        manager.create_default(tunnel=getattr(args, "tunnel", None) or "")
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    emit_ok(f"created {target}")
    cprint("edit the file to set your tunnel ID, credentials file and ingress rules.", style="dim")
    return 0


def cmd_list(args: argparse.Namespace, settings: Settings) -> int:
    try:
        manager, config = _cli_load(args, settings)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    if getattr(args, "json", False):
        print(rules_as_json(manager, config))
        return 0
    cprint(f"config:      {manager.path}")
    cprint(f"tunnel:      {config.tunnel or '(not set)'}")
    if config.credentials_file:
        cprint(f"credentials: {config.credentials_file}")
    render_rules(config.rules())
    return 0


def cmd_add(args: argparse.Namespace, settings: Settings) -> int:
    try:
        manager, config = _cli_load(args, settings)
        config.add_rule(args.hostname, args.service, args.path)
        _cli_save(manager, config)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    emit_ok(f"added: {args.hostname} -> {args.service}")
    return 0


def cmd_edit(args: argparse.Namespace, settings: Settings) -> int:
    if not any([args.new_hostname, args.service, args.path is not None]):
        emit_error("nothing to change: pass --new-hostname, --service and/or --path")
        return 1
    try:
        manager, config = _cli_load(args, settings)
        config.edit_rule(
            args.hostname,
            path=args.rule_path,
            new_hostname=args.new_hostname,
            new_service=args.service,
            new_path=args.path,
        )
        _cli_save(manager, config)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    emit_ok(f"updated rule for {args.hostname}")
    return 0


def cmd_remove(args: argparse.Namespace, settings: Settings) -> int:
    try:
        manager, config = _cli_load(args, settings)
        removed = config.remove_rule(args.hostname, args.path)
        _cli_save(manager, config)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    emit_ok(f"removed: {removed.display_hostname()} -> {removed.service}")
    return 0


def cmd_set_catch_all(args: argparse.Namespace, settings: Settings) -> int:
    try:
        manager, config = _cli_load(args, settings)
        config.set_catch_all(args.service)
        _cli_save(manager, config)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    emit_ok(f"catch-all set to {args.service}")
    return 0


def cmd_validate(args: argparse.Namespace, settings: Settings) -> int:
    try:
        manager, config = _cli_load(args, settings)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    problems = config.validate_structure()
    ok = True
    if problems:
        ok = False
        cprint("structural problems:", style="bold yellow")
        for problem in problems:
            cprint(f"  - {problem}", style="yellow")
    else:
        emit_ok("structure OK")
    cloudflared = Cloudflared.locate()
    if cloudflared.available:
        cf_ok, output = cloudflared.validate_config(manager.path)
        cprint(f"cloudflared tunnel ingress validate ({cloudflared.path}):")
        cprint(f"  {output}" if output else "  (no output)")
        ok = ok and cf_ok
    else:
        cprint("cloudflared binary not found; skipped external validation", style="dim")
    return 0 if ok else 1


def cmd_backup(args: argparse.Namespace, settings: Settings) -> int:
    try:
        manager = _cli_manager(args, settings)
        backup = manager.backup()
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    emit_ok(f"backup written: {backup}")
    return 0


def cmd_backups(args: argparse.Namespace, settings: Settings) -> int:
    try:
        manager = _cli_manager(args, settings)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    backups = manager.backups()
    if getattr(args, "json", False):
        emit_json([str(b) for b in backups])
    elif backups:
        for backup in backups:
            stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(backup.stat().st_mtime))
            cprint(f"  {backup.name}  ({stamp})")
    else:
        cprint("(no backups)")
    return 0


def cmd_restore(args: argparse.Namespace, settings: Settings) -> int:
    try:
        manager = _cli_manager(args, settings)
        backups = manager.backups()
        if not backups:
            raise ConfigError("no backups available")
        target = None
        if args.name:
            for backup in backups:
                if backup.name == args.name or str(backup) == args.name:
                    target = backup
                    break
            if target is None:
                raise ConfigError(f"backup not found: {args.name}")
        else:
            target = backups[0]
        manager.restore(target)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    emit_ok(f"restored {manager.path} from {target.name}")
    return 0


def cmd_path(args: argparse.Namespace, settings: Settings) -> int:
    integrator = PathIntegrator(Path(__file__), settings)
    if args.action == "status":
        status = integrator.status()
        if getattr(args, "json", False):
            emit_json(
                {
                    "installed": status.installed,
                    "launcher_dir": str(status.launcher_dir),
                    "on_path": status.on_path,
                    "details": status.details,
                }
            )
        else:
            state = "installed" if status.installed else "not installed"
            cprint(f"PATH integration: {state}")
            cprint(f"  {status.details}", style="dim")
        return 0
    try:
        if args.action == "install":
            message = integrator.enable()
            emit_ok(f"PATH integration enabled: {message}")
            cprint("open a NEW terminal for the 'cftcfg' command to resolve.", style="dim")
        else:
            message = integrator.disable()
            emit_ok(f"PATH integration disabled: {message}")
    except (OSError, ConfigError) as exc:
        emit_error(str(exc))
        return 1
    return 0


def cmd_settings(args: argparse.Namespace, settings: Settings) -> int:
    if args.settings_action == "show":
        emit_json(settings._data)
        cprint(f"(settings file: {settings.path})", style="dim")
        return 0
    if args.key == "config-path":
        settings["config_path"] = args.value
    elif args.key == "first-run-done":
        settings["first_run_done"] = args.value.lower() in ("1", "true", "yes")
    else:
        emit_error(f"unknown setting key: {args.key} (supported: config-path, first-run-done)")
        return 1
    try:
        settings.save()
    except ConfigError as exc:
        emit_error(str(exc))
        return 1
    emit_ok(f"set {args.key}")
    return 0


def cmd_doctor(args: argparse.Namespace, settings: Settings) -> int:
    problems = 0
    cprint(
        f"{APP_NAME} {APP_VERSION}  |  python {platform.python_version()}  |  {platform.system()} {platform.release()}"
    )
    cloudflared = Cloudflared.locate()
    if cloudflared.available:
        emit_ok(f"cloudflared: {cloudflared.path} ({cloudflared.version})")
    else:
        problems += 1
        cprint("cloudflared: NOT FOUND", style="bold red")
        cprint("  searched: " + ", ".join(cloudflared.searched), style="dim")
    config_arg = getattr(args, "config", None)
    path = find_config(config_arg, settings.get("config_path"))
    if path is None:
        problems += 1
        cprint("config: NOT FOUND", style="bold red")
        cprint(f"  run '{APP_NAME} cli init' or pass --config PATH", style="dim")
    else:
        manager = ConfigManager(path)
        try:
            config = manager.load()
            structural = config.validate_structure()
            if structural:
                problems += 1
                cprint(
                    f"config: {path} (loaded, {len(structural)} structural problem(s))",
                    style="yellow",
                )
                for problem in structural:
                    cprint(f"  - {problem}", style="yellow")
            else:
                emit_ok(f"config: {path} (valid, tunnel={config.tunnel})")
        except ConfigError as exc:
            problems += 1
            cprint(f"config: {path} ({exc})", style="bold red")
    status = PathIntegrator(Path(__file__), settings).status()
    state = "enabled" if status.installed else "disabled"
    cprint(f"PATH integration: {state} ({status.details})")
    extras = [
        f"pyyaml={'ok' if YAML_OK else 'MISSING'}",
        f"rich={'ok' if RICH_OK else 'missing'}",
        f"textual={'ok' if TEXTUAL_OK else 'missing'}",
    ]
    try:
        import tkinter  # noqa: F401

        extras.append("tkinter=ok")
    except ImportError:
        extras.append("tkinter=missing")
    cprint("python extras: " + ", ".join(extras))
    return 1 if problems else 0


def cmd_scan(args: argparse.Namespace, settings: Settings) -> int:
    cprint("scanning local ports...", style="dim")
    results = scan_ports()
    if getattr(args, "json", False):
        emit_json(
            [
                {
                    "port": p.port,
                    "process": p.process_name,
                    "what": p.what(),
                    "started_from": p.started_from(),
                    "docker": bool(p.docker),
                    "suggested_hostname": suggest_hostname(p, None),
                }
                for p in results
            ]
        )
        return 0
    if not results:
        cprint("no listening ports found")
        return 0
    table = RichTable(show_lines=False)
    table.add_column("Port", justify="right", style="cyan")
    table.add_column("Service/Container", style="green")
    table.add_column("Started From", style="dim")
    for p in results:
        table.add_row(str(p.port), p.what(), p.started_from())
    _CONSOLE.print(table)
    return 0


def build_cli_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", default=argparse.SUPPRESS, help="path to cloudflared config.yml")
    common.add_argument(
        "--json",
        action="store_true",
        default=argparse.SUPPRESS,
        help="machine-readable output where supported",
    )

    parser = argparse.ArgumentParser(
        prog=f"{APP_NAME} cli",
        description="Non-interactive cloudflared tunnel configuration management.",
        epilog="Mutating commands save immediately and always create a timestamped backup first.",
    )
    parser.add_argument("--config", default=argparse.SUPPRESS, help="path to cloudflared config.yml")
    parser.add_argument(
        "--json",
        action="store_true",
        default=argparse.SUPPRESS,
        help="machine-readable output where supported",
    )
    sub = parser.add_subparsers(dest="command", metavar="command", required=True)

    p = sub.add_parser("init", parents=[common], help="create a scaffold config file")
    p.add_argument("--path", help=f"target path (default: {default_config_path()})")
    p.add_argument("--tunnel", help="tunnel name or ID to embed")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("list", parents=[common], help="list tunnels and ingress rules")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("add", parents=[common], help="add an ingress rule")
    p.add_argument("--hostname", required=True, help="public hostname, e.g. app.example.com")
    p.add_argument("--service", required=True, help="local target, e.g. http://127.0.0.1:3000")
    p.add_argument("--path", help="optional URL path prefix, e.g. /api")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("edit", parents=[common], help="edit an existing ingress rule")
    p.add_argument("--hostname", required=True, help="hostname of the rule to edit")
    p.add_argument("--rule-path", help="path prefix of the rule to edit (disambiguation)")
    p.add_argument("--new-hostname", help="replacement hostname")
    p.add_argument("--service", help="replacement service")
    p.add_argument("--path", help="replacement path prefix ('' clears it)")
    p.set_defaults(func=cmd_edit)

    p = sub.add_parser("remove", parents=[common], help="remove an ingress rule")
    p.add_argument("--hostname", required=True)
    p.add_argument("--path", help="path prefix of the rule (disambiguation)")
    p.set_defaults(func=cmd_remove)

    p = sub.add_parser("set-catch-all", parents=[common], help="set the final catch-all rule service")
    p.add_argument("--service", required=True, help="e.g. http_status:404")
    p.set_defaults(func=cmd_set_catch_all)

    p = sub.add_parser(
        "validate",
        parents=[common],
        help="structural checks + cloudflared tunnel ingress validate",
    )
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("backup", parents=[common], help="write a timestamped backup of the config")
    p.set_defaults(func=cmd_backup)

    p = sub.add_parser("backups", parents=[common], help="list available backups")
    p.set_defaults(func=cmd_backups)

    p = sub.add_parser("restore", parents=[common], help="restore config from a backup")
    p.add_argument("name", nargs="?", help="backup file name (default: most recent)")
    p.set_defaults(func=cmd_restore)

    p = sub.add_parser("path", parents=[common], help="manage system PATH integration")
    p.add_argument("action", choices=["install", "remove", "status"])
    p.set_defaults(func=cmd_path)

    p = sub.add_parser("settings", parents=[common], help="show or change cftcfg settings")
    settings_sub = p.add_subparsers(dest="settings_action", metavar="action", required=True)
    settings_sub.add_parser("show", parents=[common], help="print settings JSON")
    p_set = settings_sub.add_parser("set", parents=[common], help="set a value")
    p_set.add_argument("key", help="config-path | first-run-done")
    p_set.add_argument("value")
    p.set_defaults(func=cmd_settings)

    p = sub.add_parser("doctor", parents=[common], help="diagnose environment and configuration")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("scan", parents=[common], help="scan local ports and suggest tunnel mappings")
    p.set_defaults(func=cmd_scan)

    return parser


def run_cli(argv: list[str]) -> int:
    parser = build_cli_parser()
    args = parser.parse_args(argv)
    settings = Settings()
    try:
        return args.func(args, settings)
    except KeyboardInterrupt:
        return 130


class ConfigSession:
    def __init__(self, manager: Optional[ConfigManager], settings: Settings):
        self.settings = settings
        self.manager = manager
        self.config: Optional[TunnelConfig] = None
        self.dirty = False
        if manager is not None and manager.exists():
            self.reload()

    def reload(self) -> None:
        assert self.manager is not None
        self.config = self.manager.load()
        self.dirty = False

    def open_path(self, path: Path) -> None:
        self.manager = ConfigManager(path)
        self.reload()
        self.settings["config_path"] = str(path)
        self.settings.save()

    def create_default(self, path: Path, tunnel: str = "") -> None:
        manager = ConfigManager(path)
        manager.create_default(tunnel)
        self.manager = manager
        self.reload()
        self.settings["config_path"] = str(path)
        self.settings.save()

    def mutate(self, operation: Callable[[], Any]) -> Any:
        result = operation()
        self.dirty = True
        return result

    def save(self) -> Optional[Path]:
        assert self.manager is not None and self.config is not None
        backup = self.manager.save(self.config, make_backup=True)
        self.dirty = False
        return backup

    def validate_all(self) -> tuple[list[str], Optional[tuple[bool, str]]]:
        assert self.manager is not None and self.config is not None
        structural = self.config.validate_structure()
        external = None
        cloudflared = Cloudflared.locate()
        if cloudflared.available and not self.dirty:
            external = cloudflared.validate_config(self.manager.path)
        return structural, external


def resolve_session(settings: Settings, explicit_config: Optional[str]) -> ConfigSession:
    path = find_config(explicit_config, settings.get("config_path"))
    manager = ConfigManager(path) if path else None
    session = ConfigSession(manager, settings)
    if manager is not None and manager.exists() and session.config is None:
        raise ConfigError(f"failed to load {manager.path}")
    return session


def run_tui(session: ConfigSession, settings: Settings) -> int:
    if TEXTUAL_OK:
        try:
            return _run_textual_tui(session, settings)
        except Exception as exc:
            cprint(f"textual UI failed ({exc}); falling back to menu UI", style="yellow", err=True)
    try:
        return _run_menu_tui(session, settings)
    except EOFError:
        print()
        return 0


def _run_textual_tui(session: ConfigSession, settings: Settings) -> int:
    app = _build_textual_app(session, settings)
    app.run()
    return 0


def _build_textual_app(session: ConfigSession, settings: Settings):
    from textual import on
    from textual.app import App, ComposeResult
    from textual.containers import Horizontal, Vertical
    from textual.screen import ModalScreen
    from textual.widgets import Button, Checkbox, DataTable, Footer, Header, Input, Label, Static

    SHARED_HOVER_CSS = """
    Button:hover {
        background: $accent;
        color: #ffffff;
        text-style: bold;
    }
    DataTable > .datatable--hover {
        background: $accent-darken-1;
        color: #ffffff;
    }
    DataTable > .datatable--cursor {
        background: $primary;
        color: #ffffff;
        text-style: bold;
    }
    """

    class ConfirmModal(ModalScreen[bool]):
        CSS = (
            SHARED_HOVER_CSS
            + """
        ConfirmModal { align: center middle; }
        #confirm-box { width: 64; height: auto; padding: 1 2; border: thick $primary;
                       background: $surface; }
        #confirm-box .buttons { height: auto; align-horizontal: right; margin-top: 1; }
        #confirm-box Button { margin-left: 2; }
        """
        )

        def __init__(self, message: str):
            super().__init__()
            self._message = message

        def compose(self) -> ComposeResult:
            with Vertical(id="confirm-box"):
                yield Label(self._message)
                with Horizontal(classes="buttons"):
                    yield Button("Confirm", id="ok", variant="error")
                    yield Button("Cancel", id="cancel", variant="primary")

        @on(Button.Pressed, "#ok")
        def _ok(self) -> None:
            self.dismiss(True)

        @on(Button.Pressed, "#cancel")
        def _cancel(self) -> None:
            self.dismiss(False)

    class RuleModal(ModalScreen[Optional[dict]]):
        CSS = (
            SHARED_HOVER_CSS
            + """
        RuleModal { align: center middle; }
        #rule-box { width: 76; height: auto; padding: 1 2; border: thick $primary;
                    background: $surface; }
        #rule-box Input { margin-bottom: 1; }
        #rule-box .buttons { height: auto; align-horizontal: right; margin-top: 1; }
        #rule-box Button { margin-left: 2; }
        #rule-error { color: $error; height: auto; }
        """
        )

        def __init__(
            self,
            title: str,
            rule: Optional[IngressRule] = None,
            catch_all: bool = False,
        ):
            super().__init__()
            self._title = title
            self._rule = rule
            self._catch_all = catch_all

        def compose(self) -> ComposeResult:
            with Vertical(id="rule-box"):
                yield Label(f"[b]{self._title}[/b]")
                if not self._catch_all:
                    yield Input(
                        value=(self._rule.hostname or "") if self._rule else "",
                        placeholder="hostname (e.g. app.example.com)",
                        id="in-hostname",
                    )
                yield Input(
                    value=(self._rule.service or "") if self._rule else "",
                    placeholder="service (e.g. http://127.0.0.1:3000)",
                    id="in-service",
                )
                if not self._catch_all:
                    yield Input(
                        value=(self._rule.path or "") if self._rule else "",
                        placeholder="path prefix (optional, e.g. /api)",
                        id="in-path",
                    )
                yield Label("", id="rule-error")
                with Horizontal(classes="buttons"):
                    yield Button("Save", id="save", variant="primary")
                    yield Button("Cancel", id="cancel")

        def _submit(self) -> None:
            service = self.query_one("#in-service", Input).value.strip()
            if self._catch_all:
                hostname, path_prefix = None, None
            else:
                hostname = self.query_one("#in-hostname", Input).value.strip()
                path_prefix = self.query_one("#in-path", Input).value.strip() or None
            error_label = self.query_one("#rule-error", Label)
            if not self._catch_all:
                error = validate_hostname(hostname or "")
                if error:
                    error_label.update(error)
                    return
            error = validate_service(service)
            if error:
                error_label.update(error)
                return
            error = validate_path_prefix(path_prefix or "")
            if error:
                error_label.update(error)
                return
            self.dismiss({"hostname": hostname, "service": service, "path": path_prefix})

        @on(Button.Pressed, "#save")
        def _save(self) -> None:
            self._submit()

        @on(Input.Submitted)
        def _submitted(self) -> None:
            self._submit()

        @on(Button.Pressed, "#cancel")
        def _cancel(self) -> None:
            self.dismiss(None)

    class PortScanModal(ModalScreen[Optional[dict]]):
        CSS = (
            SHARED_HOVER_CSS
            + """
        PortScanModal { align: center middle; }
        #scan-box { width: 92; height: 85%; padding: 1 2; border: thick $primary; background: $surface; }
        #scan-table { height: 1fr; margin-top: 1; margin-bottom: 1; }
        #scan-box .buttons { height: auto; align-horizontal: right; }
        #scan-box Button { margin-left: 2; }
        """
        )

        def __init__(self, session: ConfigSession):
            super().__init__()
            self._session = session
            self._ports: list[PortInfo] = []

        def compose(self) -> ComposeResult:
            with Vertical(id="scan-box"):
                yield Label("[b]Local Port Scanner & Tunnel Shortcut[/b]")
                yield Label("Scanning open local listening ports...", id="scan-status")
                table = DataTable(id="scan-table", zebra_stripes=True, cursor_type="row")
                table.add_columns("Port", "Service / Container", "Started From", "Suggested Hostname")
                yield table
                with Horizontal(classes="buttons"):
                    yield Button("Add Rule for Selected", id="add-selected", variant="primary")
                    yield Button("Rescan", id="rescan")
                    yield Button("Close", id="close")

        def on_mount(self) -> None:
            self._do_scan()

        def _do_scan(self) -> None:
            self.query_one("#scan-status", Label).update("Scanning ports...")
            table = self.query_one("#scan-table", DataTable)
            table.clear()
            self._ports = scan_ports()
            if not self._ports:
                self.query_one("#scan-status", Label).update("No active listening TCP ports found.")
                return
            self.query_one("#scan-status", Label).update(
                f"Found {len(self._ports)} active listening port(s):"
            )
            for idx, p in enumerate(self._ports):
                sugg = suggest_hostname(p, self._session.config)
                table.add_row(str(p.port), p.what(), p.started_from(), sugg, key=str(idx))

        @on(Button.Pressed, "#rescan")
        def _rescan(self) -> None:
            self._do_scan()

        @on(Button.Pressed, "#add-selected")
        def _add_selected(self) -> None:
            self._submit_selected()

        @on(DataTable.RowSelected)
        def _row_selected(self) -> None:
            self._submit_selected()

        def _submit_selected(self) -> None:
            table = self.query_one("#scan-table", DataTable)
            row = table.cursor_row
            if row is None or row < 0 or row >= len(self._ports):
                return
            p = self._ports[row]
            sugg = suggest_hostname(p, self._session.config)
            self.dismiss(
                {"hostname": sugg, "service": p.suggested_service, "path": None}
            )

        @on(Button.Pressed, "#close")
        def _close(self) -> None:
            self.dismiss(None)

    class SettingsModal(ModalScreen[None]):
        CSS = (
            SHARED_HOVER_CSS
            + """
        SettingsModal { align: center middle; }
        #settings-box { width: 84; height: auto; max-height: 90%; padding: 1 2;
                        border: thick $primary; background: $surface; }
        #settings-box .buttons { height: auto; align-horizontal: right; margin-top: 1; }
        #settings-box Button { margin-left: 2; }
        #settings-error { color: $error; height: auto; }
        """
        )

        def compose(self) -> ComposeResult:
            cloudflared = Cloudflared.locate()
            integrator = PathIntegrator(Path(__file__), settings)
            status = integrator.status()
            with Vertical(id="settings-box"):
                yield Label("[b]Settings[/b]")
                yield Static(
                    f"cloudflared: {cloudflared.path or 'NOT FOUND'}"
                    + (f" ({cloudflared.version})" if cloudflared.available else "")
                )
                yield Static(f"settings file: {settings.path}")
                yield Static(f"launcher dir:  {status.launcher_dir}")
                yield Label("Config path (blank = auto-discover):")
                yield Input(
                    value=settings.get("config_path") or "",
                    placeholder=str(default_config_path()),
                    id="in-config-path",
                )
                yield Checkbox(
                    "Register cftcfg on the system PATH",
                    value=status.installed,
                    id="chk-path",
                )
                yield Label("", id="settings-error")
                with Horizontal(classes="buttons"):
                    yield Button("Apply", id="apply", variant="primary")
                    yield Button("Close", id="close")

        @on(Button.Pressed, "#apply")
        def _apply(self) -> None:
            error_label = self.query_one("#settings-error", Label)
            config_path = self.query_one("#in-config-path", Input).value.strip()
            settings["config_path"] = config_path or None
            try:
                settings.save()
            except ConfigError as exc:
                error_label.update(str(exc))
                return
            integrator = PathIntegrator(Path(__file__), settings)
            wanted = self.query_one("#chk-path", Checkbox).value
            try:
                if wanted and not integrator.status().installed:
                    message = integrator.enable()
                    self.app.notify(message, title="PATH integration enabled")
                elif not wanted and integrator.status().installed:
                    message = integrator.disable()
                    self.app.notify(message, title="PATH integration disabled")
            except (OSError, ConfigError) as exc:
                error_label.update(str(exc))
                return
            self.app.notify("settings applied", title="cftcfg")

        @on(Button.Pressed, "#close")
        def _close(self) -> None:
            self.dismiss(None)

    class FirstRunModal(ModalScreen[bool]):
        CSS = (
            SHARED_HOVER_CSS
            + """
        FirstRunModal { align: center middle; }
        #first-box { width: 72; height: auto; padding: 1 2; border: thick $primary;
                     background: $surface; }
        #first-box .buttons { height: auto; align-horizontal: right; margin-top: 1; }
        #first-box Button { margin-left: 2; }
        """
        )

        def compose(self) -> ComposeResult:
            with Vertical(id="first-box"):
                yield Label("[b]Welcome to cftcfg[/b]")
                yield Label(
                    "Add cftcfg to your system PATH so you can launch it from any "
                    "terminal by typing 'cftcfg'?\n(You can change this later in Settings.)"
                )
                with Horizontal(classes="buttons"):
                    yield Button("Add to PATH", id="yes", variant="primary")
                    yield Button("Not now", id="no")

        @on(Button.Pressed, "#yes")
        def _yes(self) -> None:
            self.dismiss(True)

        @on(Button.Pressed, "#no")
        def _no(self) -> None:
            self.dismiss(False)

    class CftcfgApp(App):
        TITLE = "cftcfg"
        ENABLE_COMMAND_PALETTE = False
        CSS = (
            SHARED_HOVER_CSS
            + """
        #summary { height: auto; padding: 0 1; background: $boost; }
        #toolbar { height: auto; padding: 0 1; }
        #toolbar Button { margin-right: 1; }
        #rules { height: 1fr; }
        #statusbar { dock: bottom; height: 1; padding: 0 1; background: $panel; }
        """
        )
        BINDINGS = [
            ("a", "add", "Add"),
            ("e", "edit", "Edit"),
            ("d", "delete", "Delete"),
            ("p", "scan_ports", "Scan Ports"),
            ("v", "validate", "Validate"),
            ("s", "save", "Save"),
            ("r", "reload", "Reload"),
            ("b", "backup", "Backup"),
            ("g", "settings", "Settings"),
            ("q", "quit", "Quit"),
        ]

        def __init__(self):
            super().__init__()
            self.session = session
            self._row_rule_index: list[int] = []

        def compose(self) -> ComposeResult:
            yield Header()
            yield Static("", id="summary")
            with Horizontal(id="toolbar"):
                yield Button("Add", id="btn-add")
                yield Button("Edit", id="btn-edit")
                yield Button("Delete", id="btn-delete")
                yield Button("Scan Ports", id="btn-scan")
                yield Button("Validate", id="btn-validate")
                yield Button("Save", id="btn-save", variant="primary")
                yield Button("Settings", id="btn-settings")
            table = DataTable(id="rules", zebra_stripes=True, cursor_type="row")
            table.add_columns("#", "Hostname", "Service", "Path")
            yield table
            yield Static("", id="statusbar")
            yield Footer()

        def on_mount(self) -> None:
            self._refresh()
            if session.config is None:
                self._set_status(
                    "no config found - press 'r' after creating one, or set a path in Settings (g)"
                )
            if not settings.get("first_run_done"):
                self.push_screen(FirstRunModal(), self._first_run_done)

        def _first_run_done(self, add_to_path: Optional[bool]) -> None:
            settings["first_run_done"] = True
            try:
                settings.save()
            except ConfigError:
                pass
            if add_to_path:
                try:
                    message = PathIntegrator(Path(__file__), settings).enable()
                    self.notify(message, title="PATH integration enabled")
                except (OSError, ConfigError) as exc:
                    self.notify(str(exc), title="PATH integration failed", severity="error")

        def _set_status(self, text: str) -> None:
            self.query_one("#statusbar", Static).update(text)

        def _refresh(self) -> None:
            summary = self.query_one("#summary", Static)
            table = self.query_one("#rules", DataTable)
            table.clear()
            self._row_rule_index = []
            if session.config is None or session.manager is None:
                summary.update("[b]No cloudflared config loaded[/b]")
                self.sub_title = ""
                return
            cfg = session.config
            manager = session.manager
            summary.update(
                f"[b]{manager.path}[/b]   tunnel: {cfg.tunnel or '(not set)'}"
                + (f"   credentials: {cfg.credentials_file}" if cfg.credentials_file else "")
            )
            marker = " *unsaved*" if session.dirty else ""
            self.sub_title = f"tunnel: {cfg.tunnel or '?'}{marker}"
            for idx, rule in enumerate(cfg.rules(), 1):
                table.add_row(
                    str(idx),
                    rule.display_hostname(),
                    rule.service,
                    rule.path or "",
                    key=str(idx - 1),
                )
                self._row_rule_index.append(idx - 1)

        def _selected_rule(self) -> Optional[IngressRule]:
            if session.config is None:
                return None
            table = self.query_one("#rules", DataTable)
            if not self._row_rule_index:
                return None
            row = table.cursor_row
            if row is None or row >= len(self._row_rule_index):
                return None
            try:
                return session.config.rules()[self._row_rule_index[row]]
            except (ConfigError, IndexError):
                return None

        def _guard_config(self) -> bool:
            if session.config is None:
                self.notify(
                    "no config loaded - set a config path in Settings (g)", severity="error"
                )
                return False
            return True

        def action_add(self) -> None:
            if not self._guard_config():
                return
            self.push_screen(RuleModal("Add ingress rule"), self._apply_add)

        def _apply_add(self, result: Optional[dict]) -> None:
            if not result or session.config is None:
                return
            try:
                session.mutate(
                    lambda: session.config.add_rule(
                        result["hostname"], result["service"], result["path"]
                    )
                )
            except ConfigError as exc:
                self.notify(str(exc), title="add failed", severity="error")
                return
            self._refresh()
            self._set_status(f"added {result['hostname']} (unsaved)")

        def action_edit(self) -> None:
            if not self._guard_config():
                return
            rule = self._selected_rule()
            if rule is None:
                self.notify("select a rule to edit", severity="warning")
                return
            title = "Edit catch-all rule" if rule.is_catch_all else f"Edit {rule.hostname}"
            self.push_screen(
                RuleModal(title, rule=rule, catch_all=rule.is_catch_all),
                lambda result: self._apply_edit(rule, result),
            )

        def _apply_edit(self, rule: IngressRule, result: Optional[dict]) -> None:
            if not result or session.config is None:
                return
            try:
                if rule.is_catch_all:
                    session.mutate(lambda: session.config.set_catch_all(result["service"]))
                else:
                    session.mutate(
                        lambda: session.config.edit_rule(
                            rule.hostname or "",
                            path=rule.path,
                            new_hostname=result["hostname"],
                            new_service=result["service"],
                            new_path=result["path"] or "",
                        )
                    )
            except ConfigError as exc:
                self.notify(str(exc), title="edit failed", severity="error")
                return
            self._refresh()
            self._set_status("rule updated (unsaved)")

        def action_delete(self) -> None:
            if not self._guard_config():
                return
            rule = self._selected_rule()
            if rule is None:
                self.notify("select a rule to delete", severity="warning")
                return
            if rule.is_catch_all:
                self.notify(
                    "the catch-all rule cannot be deleted; edit it instead", severity="warning"
                )
                return
            self.push_screen(
                ConfirmModal(f"Delete rule {rule.hostname} -> {rule.service}?"),
                lambda confirmed: self._apply_delete(rule, confirmed),
            )

        def _apply_delete(self, rule: IngressRule, confirmed: Optional[bool]) -> None:
            if not confirmed or session.config is None:
                return
            try:
                session.mutate(
                    lambda: session.config.remove_rule(rule.hostname or "", rule.path)
                )
            except ConfigError as exc:
                self.notify(str(exc), title="delete failed", severity="error")
                return
            self._refresh()
            self._set_status(f"deleted {rule.hostname} (unsaved)")

        def action_scan_ports(self) -> None:
            if not self._guard_config():
                return
            self.push_screen(PortScanModal(session), self._apply_scan_result)

        def _apply_scan_result(self, result: Optional[dict]) -> None:
            if not result:
                return
            rule = IngressRule(
                hostname=result["hostname"], service=result["service"], path=result["path"]
            )
            self.push_screen(RuleModal("Add Tunnel Shortcut", rule=rule), self._apply_add)

        async def action_validate(self) -> None:
            if not self._guard_config():
                return
            self._set_status("validating...")
            structural, external = await asyncio.to_thread(session.validate_all)
            lines = []
            ok = True
            if structural:
                ok = False
                lines.append("structure: " + "; ".join(structural))
            else:
                lines.append("structure OK")
            if external is None:
                if session.dirty:
                    lines.append("save first to run cloudflared validation")
                else:
                    lines.append("cloudflared binary not found; external validation skipped")
            else:
                ext_ok, output = external
                ok = ok and ext_ok
                first_line = output.splitlines()[0] if output else ("OK" if ext_ok else "failed")
                lines.append(f"cloudflared: {first_line}")
            self._set_status(" | ".join(lines))
            self.notify(
                "validation passed" if ok else "validation reported problems",
                title="validate",
                severity="information" if ok else "warning",
            )

        def action_save(self) -> None:
            if not self._guard_config():
                return
            try:
                backup = session.save()
            except ConfigError as exc:
                self.notify(str(exc), title="save failed", severity="error")
                return
            self._refresh()
            suffix = f" (backup: {backup.name})" if backup else ""
            if session.manager is not None:
                self._set_status(f"saved {session.manager.path}{suffix}")

        def action_reload(self) -> None:
            if session.manager is None:
                path = find_config(None, settings.get("config_path"))
                if path is None:
                    self.notify("still no config found", severity="warning")
                    return
                try:
                    session.open_path(path)
                except ConfigError as exc:
                    self.notify(str(exc), title="reload failed", severity="error")
                    return
            else:
                try:
                    session.reload()
                except ConfigError as exc:
                    self.notify(str(exc), title="reload failed", severity="error")
                    return
            self._refresh()
            self._set_status("reloaded from disk")

        def action_backup(self) -> None:
            if session.manager is None or not session.manager.exists():
                self.notify("no config file to back up", severity="warning")
                return
            try:
                backup = session.manager.backup()
            except ConfigError as exc:
                self.notify(str(exc), title="backup failed", severity="error")
                return
            self._set_status(f"backup written: {backup}")

        def action_settings(self) -> None:
            self.push_screen(SettingsModal())

        def action_quit(self) -> None:
            if session.dirty:
                self.push_screen(
                    ConfirmModal("You have unsaved changes. Quit without saving?"),
                    lambda confirmed: self.exit() if confirmed else None,
                )
            else:
                self.exit()

        @on(DataTable.RowSelected)
        def _row_selected(self, event: DataTable.RowSelected) -> None:
            self.action_edit()

        @on(Button.Pressed, "#btn-add")
        def _btn_add(self) -> None:
            self.action_add()

        @on(Button.Pressed, "#btn-edit")
        def _btn_edit(self) -> None:
            self.action_edit()

        @on(Button.Pressed, "#btn-delete")
        def _btn_delete(self) -> None:
            self.action_delete()

        @on(Button.Pressed, "#btn-scan")
        def _btn_scan(self) -> None:
            self.action_scan_ports()

        @on(Button.Pressed, "#btn-validate")
        def _btn_validate(self) -> None:
            self.run_worker(self.action_validate())

        @on(Button.Pressed, "#btn-save")
        def _btn_save(self) -> None:
            self.action_save()

        @on(Button.Pressed, "#btn-settings")
        def _btn_settings(self) -> None:
            self.action_settings()

    return CftcfgApp()


def _prompt(text: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{text}{suffix}: ").strip()
    return value or default


def _prompt_yes_no(text: str, default: bool = False) -> bool:
    hint = "Y/n" if default else "y/N"
    try:
        answer = _prompt(f"{text} ({hint})").lower()
    except EOFError:
        return default
    if not answer:
        return default
    return answer in ("y", "yes")


def _run_menu_tui(session: ConfigSession, settings: Settings) -> int:
    if not settings.get("first_run_done"):
        settings["first_run_done"] = True
        try:
            settings.save()
        except ConfigError:
            pass
        if _prompt_yes_no("Add cftcfg to your system PATH so 'cftcfg' works in any terminal?"):
            try:
                message = PathIntegrator(Path(__file__), settings).enable()
                emit_ok(f"PATH integration enabled: {message}")
                cprint("open a NEW terminal for the change to take effect.", style="dim")
            except (OSError, ConfigError) as exc:
                emit_error(str(exc))

    def require_config() -> bool:
        if session.config is None:
            emit_error("no config loaded - use (p) to set/create a config path")
            return False
        return True

    def show() -> None:
        print()
        if session.config is None or session.manager is None:
            cprint("== cftcfg ==  no config loaded", style="bold")
        else:
            marker = " *unsaved changes*" if session.dirty else ""
            cprint(
                f"== cftcfg ==  {session.manager.path}  tunnel={session.config.tunnel or '(not set)'}{marker}",
                style="bold",
            )
            render_rules(session.config.rules())
        print()
        cprint(
            "(a)dd  (e)dit  (d)elete  (o) ports scan  (c)atch-all  (v)alidate  (s)ave  (r)eload  "
            "(b)ackup  (p)ath/config  PATH (i)ntegration  (q)uit",
            style="dim",
        )

    while True:
        show()
        try:
            choice = _prompt("choice").lower()
        except EOFError:
            print()
            return 0
        if choice in ("q", "quit", "exit"):
            if session.dirty and not _prompt_yes_no("Unsaved changes - quit without saving?"):
                continue
            return 0
        if choice == "a":
            if not require_config() or session.config is None:
                continue
            hostname = _prompt("hostname (e.g. app.example.com)")
            service = _prompt("service (e.g. http://127.0.0.1:3000)")
            path_prefix = _prompt("path prefix (optional)") or None
            try:
                session.mutate(lambda: session.config.add_rule(hostname, service, path_prefix))
                emit_ok(f"added {hostname} (unsaved - press s to save)")
            except ConfigError as exc:
                emit_error(str(exc))
        elif choice == "o":
            if not require_config() or session.config is None:
                continue
            cprint("scanning ports...", style="dim")
            ports = scan_ports()
            if not ports:
                cprint("no listening ports found")
                continue
            for idx, p in enumerate(ports, 1):
                sugg = suggest_hostname(p, session.config)
                cprint(
                    f"  [{idx}] Port {p.port:<5} | {p.what():<35} | {p.started_from():<25} | suggested: {sugg}"
                )
            num = _prompt("enter # to add to tunnel (or enter to cancel)")
            if num.isdigit() and 1 <= int(num) <= len(ports):
                p = ports[int(num) - 1]
                sugg = suggest_hostname(p, session.config)
                hostname = _prompt("hostname", sugg)
                service = _prompt("service", p.suggested_service)
                try:
                    session.mutate(lambda: session.config.add_rule(hostname, service))
                    emit_ok(f"added {hostname} -> {service} (unsaved - press s to save)")
                except ConfigError as exc:
                    emit_error(str(exc))
        elif choice == "e":
            if not require_config() or session.config is None:
                continue
            hostname = _prompt("hostname of rule to edit ('catch-all' for the final rule)")
            try:
                if hostname in ("catch-all", CATCH_ALL_LABEL, ""):
                    service = _prompt("new catch-all service", "http_status:404")
                    session.mutate(lambda: session.config.set_catch_all(service))
                else:
                    new_hostname = _prompt("new hostname (blank keeps current)")
                    new_service = _prompt("new service (blank keeps current)")
                    new_path = _prompt("new path prefix (blank clears, '.' keeps)")
                    session.mutate(
                        lambda: session.config.edit_rule(
                            hostname,
                            new_hostname=new_hostname or None,
                            new_service=new_service or None,
                            new_path=None if new_path == "." else new_path,
                        )
                    )
                emit_ok("rule updated (unsaved - press s to save)")
            except ConfigError as exc:
                emit_error(str(exc))
        elif choice == "d":
            if not require_config() or session.config is None:
                continue
            hostname = _prompt("hostname of rule to delete")
            if not hostname:
                emit_error("hostname required (the catch-all cannot be deleted; edit it instead)")
                continue
            if _prompt_yes_no(f"delete {hostname}?"):
                try:
                    removed = session.mutate(lambda: session.config.remove_rule(hostname))
                    emit_ok(f"deleted {removed.display_hostname()} (unsaved - press s to save)")
                except ConfigError as exc:
                    emit_error(str(exc))
        elif choice == "c":
            if not require_config() or session.config is None:
                continue
            service = _prompt("catch-all service", "http_status:404")
            try:
                session.mutate(lambda: session.config.set_catch_all(service))
                emit_ok("catch-all updated (unsaved - press s to save)")
            except ConfigError as exc:
                emit_error(str(exc))
        elif choice == "v":
            if not require_config():
                continue
            structural, external = session.validate_all()
            if structural:
                for problem in structural:
                    cprint(f"  - {problem}", style="yellow")
            else:
                emit_ok("structure OK")
            if external is None:
                cprint(
                    "cloudflared validation skipped"
                    + (" (save first)" if session.dirty else " (binary not found)"),
                    style="dim",
                )
            else:
                ok, output = external
                cprint(f"cloudflared: {output}", style="green" if ok else "red")
        elif choice == "s":
            if not require_config() or session.manager is None:
                continue
            try:
                backup = session.save()
                emit_ok(
                    f"saved {session.manager.path}"
                    + (f" (backup: {backup.name})" if backup else "")
                )
            except ConfigError as exc:
                emit_error(str(exc))
        elif choice == "r":
            try:
                if session.manager is None:
                    path = find_config(None, settings.get("config_path"))
                    if path is None:
                        emit_error("no config found on disk")
                        continue
                    session.open_path(path)
                else:
                    session.reload()
                emit_ok("reloaded")
            except ConfigError as exc:
                emit_error(str(exc))
        elif choice == "b":
            if session.manager is None or not session.manager.exists():
                emit_error("no config file to back up")
                continue
            try:
                emit_ok(f"backup written: {session.manager.backup()}")
            except ConfigError as exc:
                emit_error(str(exc))
        elif choice == "p":
            current = settings.get("config_path") or ""
            value = _prompt("config path (blank = auto-discover)", current)
            settings["config_path"] = value or None
            try:
                settings.save()
            except ConfigError as exc:
                emit_error(str(exc))
                continue
            if value:
                target = Path(value).expanduser()
                if not target.exists() and _prompt_yes_no(
                    f"{target} does not exist - create scaffold?"
                ):
                    try:
                        session.create_default(target)
                        emit_ok(f"created and loaded {target}")
                    except ConfigError as exc:
                        emit_error(str(exc))
                    continue
                try:
                    session.open_path(target)
                    emit_ok(f"loaded {target}")
                except ConfigError as exc:
                    emit_error(str(exc))
        elif choice == "i":
            integrator = PathIntegrator(Path(__file__), settings)
            status = integrator.status()
            cprint(
                f"status: {'installed' if status.installed else 'not installed'} - {status.details}"
            )
            if _prompt_yes_no("enable PATH integration?", default=not status.installed):
                try:
                    if status.installed:
                        emit_ok(integrator.disable())
                    else:
                        message = integrator.enable()
                        emit_ok(message)
                        cprint("open a NEW terminal for the change to take effect.", style="dim")
                except (OSError, ConfigError) as exc:
                    emit_error(str(exc))
        else:
            cprint("unknown choice", style="dim")


def run_gui(session: ConfigSession, settings: Settings) -> int:
    return _build_gui(session, settings).run()


def _build_gui(session: ConfigSession, settings: Settings):
    import queue
    import threading
    import tkinter as tk
    from tkinter import filedialog, messagebox, simpledialog, ttk

    class RuleDialog(simpledialog.Dialog):
        def __init__(
            self,
            parent: Any,
            title: str,
            rule: Optional[IngressRule] = None,
            catch_all: bool = False,
        ):
            self.rule = rule
            self.catch_all = catch_all
            self.result: Optional[dict] = None
            super().__init__(parent, title)

        def body(self, master: Any) -> Any:
            self.resizable(False, False)
            row = 0
            if not self.catch_all:
                tk.Label(master, text="Hostname:").grid(row=row, column=0, sticky="e", padx=4, pady=4)
                self.hostname_var = tk.StringVar(value=(self.rule.hostname or "") if self.rule else "")
                tk.Entry(master, textvariable=self.hostname_var, width=42).grid(
                    row=row, column=1, padx=4, pady=4
                )
                row += 1
            tk.Label(master, text="Service:").grid(row=row, column=0, sticky="e", padx=4, pady=4)
            self.service_var = tk.StringVar(value=(self.rule.service or "") if self.rule else "")
            tk.Entry(master, textvariable=self.service_var, width=42).grid(
                row=row, column=1, padx=4, pady=4
            )
            row += 1
            if not self.catch_all:
                tk.Label(master, text="Path prefix:").grid(row=row, column=0, sticky="e", padx=4, pady=4)
                self.path_var = tk.StringVar(value=(self.rule.path or "") if self.rule else "")
                tk.Entry(master, textvariable=self.path_var, width=42).grid(
                    row=row, column=1, padx=4, pady=4
                )
            return master

        def validate(self) -> bool:
            hostname = getattr(self, "hostname_var", tk.StringVar()).get().strip()
            service = self.service_var.get().strip()
            path_prefix = getattr(self, "path_var", tk.StringVar()).get().strip()
            if not self.catch_all:
                error = validate_hostname(hostname)
                if error:
                    messagebox.showerror("cftcfg", error, parent=self)
                    return False
            error = validate_service(service)
            if error:
                messagebox.showerror("cftcfg", error, parent=self)
                return False
            error = validate_path_prefix(path_prefix)
            if error:
                messagebox.showerror("cftcfg", error, parent=self)
                return False
            self.result = {
                "hostname": hostname if not self.catch_all else None,
                "service": service,
                "path": path_prefix or None if not self.catch_all else None,
            }
            return True

    class PortScanDialog(simpledialog.Dialog):
        def __init__(self, parent: Any, session: ConfigSession):
            self.session = session
            self.result: Optional[dict] = None
            self.ports: list[PortInfo] = []
            super().__init__(parent, "Scan Local Ports")

        def body(self, master: Any) -> Any:
            self.geometry("780x420")
            tk.Label(
                master, text="Discovered listening ports and containers:", font=("sans-serif", 10, "bold")
            ).pack(anchor="w", padx=8, pady=(8, 4))

            frame = ttk.Frame(master)
            frame.pack(fill="both", expand=True, padx=8, pady=4)

            columns = ("port", "what", "started", "suggested")
            self.tree = ttk.Treeview(frame, columns=columns, show="headings", selectmode="browse")
            self.tree.heading("port", text="Port")
            self.tree.heading("what", text="Service / Container")
            self.tree.heading("started", text="Started From")
            self.tree.heading("suggested", text="Suggested Hostname")

            self.tree.column("port", width=70, anchor="e")
            self.tree.column("what", width=250)
            self.tree.column("started", width=220)
            self.tree.column("suggested", width=200)

            scrollbar = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
            self.tree.configure(yscrollcommand=scrollbar.set)
            self.tree.pack(side="left", fill="both", expand=True)
            scrollbar.pack(side="left", fill="y")

            self.tree.bind("<Double-1>", lambda _e: self.apply_selected())
            self._do_scan()
            return self.tree

        def _do_scan(self) -> None:
            for item in self.tree.get_children():
                self.tree.delete(item)
            self.ports = scan_ports()
            for p in self.ports:
                sugg = suggest_hostname(p, self.session.config)
                self.tree.insert("", "end", values=(str(p.port), p.what(), p.started_from(), sugg))

        def buttonbox(self) -> None:
            box = ttk.Frame(self)
            ttk.Button(box, text="Add Shortcut to Cloudflare Tunnel", command=self.apply_selected).pack(
                side="left", padx=6, pady=8
            )
            ttk.Button(box, text="Rescan", command=self._do_scan).pack(side="left", padx=6, pady=8)
            ttk.Button(box, text="Cancel", command=self.cancel).pack(side="right", padx=6, pady=8)
            box.pack(fill="x")

        def apply_selected(self) -> None:
            selection = self.tree.selection()
            if not selection:
                messagebox.showinfo("cftcfg", "Please select a port from the list.", parent=self)
                return
            idx = self.tree.index(selection[0])
            if idx < 0 or idx >= len(self.ports):
                return
            p = self.ports[idx]
            sugg = suggest_hostname(p, self.session.config)
            self.result = {"hostname": sugg, "service": p.suggested_service, "path": None}
            self.ok()

    class CftcfgGui:
        def __init__(self):
            self.root = tk.Tk()
            self.root.title("cftcfg")
            self.root.geometry("860x520")
            self.tasks: queue.Queue[tuple[Callable[..., Any], tuple[Any, ...]]] = queue.Queue()
            self._build_menu()
            self._build_body()
            self.root.protocol("WM_DELETE_WINDOW", self.on_close)
            self.refresh()
            self.root.after(120, self._poll_tasks)
            if not settings.get("first_run_done"):
                self.root.after(200, self._first_run)

        def _build_menu(self) -> None:
            menubar = tk.Menu(self.root)
            file_menu = tk.Menu(menubar, tearoff=0)
            file_menu.add_command(label="Open config...", command=self.open_config)
            file_menu.add_command(label="New config...", command=self.new_config)
            file_menu.add_separator()
            file_menu.add_command(label="Save", accelerator="Ctrl+S", command=self.save)
            file_menu.add_command(label="Backup now", command=self.backup)
            file_menu.add_command(label="Restore backup...", command=self.restore)
            file_menu.add_separator()
            file_menu.add_command(label="Exit", command=self.on_close)
            menubar.add_cascade(label="File", menu=file_menu)

            tools_menu = tk.Menu(menubar, tearoff=0)
            tools_menu.add_command(label="Scan Local Ports...", command=self.scan_ports)
            menubar.add_cascade(label="Tools", menu=tools_menu)

            settings_menu = tk.Menu(menubar, tearoff=0)
            self.path_var = tk.BooleanVar(
                value=PathIntegrator(Path(__file__), settings).status().installed
            )
            settings_menu.add_checkbutton(
                label="Register cftcfg on system PATH",
                variable=self.path_var,
                command=self.toggle_path,
            )
            settings_menu.add_command(label="Environment doctor", command=self.doctor)
            menubar.add_cascade(label="Settings", menu=settings_menu)

            help_menu = tk.Menu(menubar, tearoff=0)
            help_menu.add_command(
                label="About",
                command=lambda: messagebox.showinfo(
                    "About cftcfg",
                    f"cftcfg {APP_VERSION}\nCloudflare Tunnel configuration manager\n\n"
                    f"config: {session.manager.path if session.manager else '(none)'}",
                ),
            )
            menubar.add_cascade(label="Help", menu=help_menu)
            self.root.config(menu=menubar)
            self.root.bind("<Control-s>", lambda _e: self.save())

        def _build_body(self) -> None:
            top = ttk.Frame(self.root, padding=(8, 6))
            top.pack(fill="x")
            self.summary_var = tk.StringVar(value="")
            ttk.Label(top, textvariable=self.summary_var).pack(side="left")

            toolbar = ttk.Frame(self.root, padding=(8, 0))
            toolbar.pack(fill="x")
            for label, command in (
                ("Add", self.add_rule),
                ("Edit", self.edit_rule),
                ("Delete", self.delete_rule),
                ("Scan Ports", self.scan_ports),
                ("Catch-all", self.edit_catch_all),
                ("Validate", self.validate),
                ("Save", self.save),
                ("Reload", self.reload),
                ("Backup", self.backup),
            ):
                ttk.Button(toolbar, text=label, command=command).pack(side="left", padx=(0, 6))

            columns = ("hostname", "service", "path")
            self.tree = ttk.Treeview(self.root, columns=columns, show="headings", selectmode="browse")
            self.tree.heading("hostname", text="Hostname")
            self.tree.heading("service", text="Service")
            self.tree.heading("path", text="Path")
            self.tree.column("hostname", width=300)
            self.tree.column("service", width=330)
            self.tree.column("path", width=140)
            scrollbar = ttk.Scrollbar(self.root, orient="vertical", command=self.tree.yview)
            self.tree.configure(yscrollcommand=scrollbar.set)
            self.tree.pack(side="left", fill="both", expand=True, padx=(8, 0), pady=8)
            scrollbar.pack(side="left", fill="y", pady=8, padx=(0, 8))
            self.tree.bind("<Double-1>", lambda _e: self.edit_rule())

            self.status_var = tk.StringVar(value="")
            ttk.Label(
                self.root,
                textvariable=self.status_var,
                relief="sunken",
                anchor="w",
                padding=(6, 2),
            ).pack(side="bottom", fill="x")

        def _set_status(self, text: str) -> None:
            self.status_var.set(text)

        def _require_config(self) -> bool:
            if session.config is None:
                messagebox.showwarning("cftcfg", "No config loaded. Use File > Open/New config.")
                return False
            return True

        def refresh(self) -> None:
            for item in self.tree.get_children():
                self.tree.delete(item)
            if session.config is None or session.manager is None:
                self.summary_var.set("No cloudflared config loaded")
                self.root.title("cftcfg")
                return
            cfg = session.config
            self.summary_var.set(
                f"{session.manager.path}   |   tunnel: {cfg.tunnel or '(not set)'}"
                + (f"   |   credentials: {cfg.credentials_file}" if cfg.credentials_file else "")
            )
            self.root.title(f"cftcfg - {session.manager.path}" + (" *" if session.dirty else ""))
            for rule in cfg.rules():
                self.tree.insert(
                    "", "end", values=(rule.display_hostname(), rule.service, rule.path or "")
                )

        def _selected_rule(self) -> Optional[IngressRule]:
            if session.config is None:
                return None
            selection = self.tree.selection()
            if not selection:
                return None
            index = self.tree.index(selection[0])
            try:
                return session.config.rules()[index]
            except (ConfigError, IndexError):
                return None

        def _run_background(
            self, work: Callable[[], Any], done: Callable[[tuple[bool, Any]], None]
        ) -> None:
            def runner() -> None:
                try:
                    result = (True, work())
                except Exception as exc:
                    result = (False, exc)
                self.tasks.put((done, (result,)))

            threading.Thread(target=runner, daemon=True).start()

        def _poll_tasks(self) -> None:
            try:
                while True:
                    callback, args = self.tasks.get_nowait()
                    callback(*args)
            except queue.Empty:
                pass
            self.root.after(120, self._poll_tasks)

        def _first_run(self) -> None:
            settings["first_run_done"] = True
            try:
                settings.save()
            except ConfigError:
                pass
            if messagebox.askyesno(
                "Welcome to cftcfg",
                "Add cftcfg to your system PATH so you can launch it from any "
                "terminal by typing 'cftcfg'?\n\n(Changeable later in Settings.)",
            ):
                try:
                    message = PathIntegrator(Path(__file__), settings).enable()
                    self.path_var.set(True)
                    messagebox.showinfo(
                        "cftcfg",
                        f"PATH integration enabled.\n{message}\n\n"
                        "Open a new terminal for the change to take effect.",
                    )
                except (OSError, ConfigError) as exc:
                    messagebox.showerror("cftcfg", str(exc))

        def add_rule(self) -> None:
            if not self._require_config() or session.config is None:
                return
            dialog = RuleDialog(self.root, "Add ingress rule")
            if not dialog.result:
                return
            try:
                session.mutate(
                    lambda: session.config.add_rule(
                        dialog.result["hostname"], dialog.result["service"], dialog.result["path"]
                    )
                )
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status(f"added {dialog.result['hostname']} (unsaved)")

        def scan_ports(self) -> None:
            if not self._require_config() or session.config is None:
                return
            dialog = PortScanDialog(self.root, session)
            if not dialog.result:
                return
            rule = IngressRule(
                hostname=dialog.result["hostname"],
                service=dialog.result["service"],
                path=dialog.result["path"],
            )
            rule_dialog = RuleDialog(self.root, "Add Tunnel Shortcut", rule=rule)
            if not rule_dialog.result:
                return
            try:
                session.mutate(
                    lambda: session.config.add_rule(
                        rule_dialog.result["hostname"],
                        rule_dialog.result["service"],
                        rule_dialog.result["path"],
                    )
                )
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status(f"added {rule_dialog.result['hostname']} (unsaved)")

        def edit_rule(self) -> None:
            if not self._require_config() or session.config is None:
                return
            rule = self._selected_rule()
            if rule is None:
                messagebox.showinfo("cftcfg", "Select a rule to edit.")
                return
            dialog = RuleDialog(
                self.root,
                f"Edit {rule.display_hostname()}",
                rule=rule,
                catch_all=rule.is_catch_all,
            )
            if not dialog.result:
                return
            try:
                if rule.is_catch_all:
                    session.mutate(lambda: session.config.set_catch_all(dialog.result["service"]))
                else:
                    session.mutate(
                        lambda: session.config.edit_rule(
                            rule.hostname or "",
                            path=rule.path,
                            new_hostname=dialog.result["hostname"],
                            new_service=dialog.result["service"],
                            new_path=dialog.result["path"] or "",
                        )
                    )
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status("rule updated (unsaved)")

        def edit_catch_all(self) -> None:
            if not self._require_config() or session.config is None:
                return
            rules = session.config.rules()
            catch_all = next((r for r in rules if r.is_catch_all), None)
            dialog = RuleDialog(self.root, "Edit catch-all rule", rule=catch_all, catch_all=True)
            if not dialog.result:
                return
            try:
                session.mutate(lambda: session.config.set_catch_all(dialog.result["service"]))
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status("catch-all updated (unsaved)")

        def delete_rule(self) -> None:
            if not self._require_config() or session.config is None:
                return
            rule = self._selected_rule()
            if rule is None:
                messagebox.showinfo("cftcfg", "Select a rule to delete.")
                return
            if rule.is_catch_all:
                messagebox.showinfo("cftcfg", "The catch-all rule cannot be deleted; edit it instead.")
                return
            if not messagebox.askyesno("cftcfg", f"Delete {rule.hostname} -> {rule.service}?"):
                return
            try:
                session.mutate(
                    lambda: session.config.remove_rule(rule.hostname or "", rule.path)
                )
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status(f"deleted {rule.hostname} (unsaved)")

        def validate(self) -> None:
            if not self._require_config():
                return
            self._set_status("validating...")

            def work() -> tuple[list[str], Optional[tuple[bool, str]]]:
                return session.validate_all()

            def done(result: tuple[bool, Any]) -> None:
                ok_flag, payload = result
                if not ok_flag:
                    messagebox.showerror("cftcfg", f"validation failed: {payload}")
                    self._set_status("validation error")
                    return
                structural, external = payload
                parts = []
                ok = True
                if structural:
                    ok = False
                    parts.append("Structure:\n" + "\n".join(f"  - {p}" for p in structural))
                else:
                    parts.append("Structure: OK")
                if external is None:
                    parts.append(
                        "cloudflared: skipped ("
                        + ("unsaved changes" if session.dirty else "binary not found")
                        + ")"
                    )
                else:
                    ext_ok, output = external
                    ok = ok and ext_ok
                    parts.append(f"cloudflared:\n{output}")
                self._set_status("validation " + ("passed" if ok else "reported problems"))
                messagebox.showinfo("cftcfg validation", "\n\n".join(parts))

            self._run_background(work, done)

        def save(self) -> None:
            if not self._require_config() or session.manager is None:
                return
            try:
                backup = session.save()
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status(
                f"saved {session.manager.path}"
                + (f" (backup: {backup.name})" if backup else "")
            )

        def reload(self) -> None:
            try:
                if session.manager is None:
                    path = find_config(None, settings.get("config_path"))
                    if path is None:
                        messagebox.showwarning("cftcfg", "No config found on disk.")
                        return
                    session.open_path(path)
                else:
                    session.reload()
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status("reloaded from disk")

        def backup(self) -> None:
            if session.manager is None or not session.manager.exists():
                messagebox.showwarning("cftcfg", "No config file to back up.")
                return
            try:
                backup = session.manager.backup()
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self._set_status(f"backup written: {backup}")

        def restore(self) -> None:
            if session.manager is None:
                messagebox.showwarning("cftcfg", "No config loaded.")
                return
            backups = session.manager.backups()
            if not backups:
                messagebox.showinfo("cftcfg", "No backups available.")
                return
            chosen = simpledialog.askstring(
                "Restore backup",
                "Available backups (newest first):\n"
                + "\n".join(b.name for b in backups[:12])
                + "\n\nEnter backup name to restore (blank = newest):",
                parent=self.root,
            )
            if chosen is None:
                return
            target = (
                backups[0]
                if not chosen.strip()
                else next((b for b in backups if b.name == chosen.strip()), None)
            )
            if target is None:
                messagebox.showerror("cftcfg", f"backup not found: {chosen}")
                return
            try:
                session.manager.restore(target)
                session.reload()
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status(f"restored from {target.name}")

        def open_config(self) -> None:
            filename = filedialog.askopenfilename(
                title="Open cloudflared config",
                filetypes=[("YAML config", "*.yml *.yaml"), ("All files", "*.*")],
            )
            if not filename:
                return
            try:
                session.open_path(Path(filename))
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status(f"loaded {filename}")

        def new_config(self) -> None:
            filename = filedialog.asksaveasfilename(
                title="Create cloudflared config",
                defaultextension=".yml",
                initialdir=str(default_config_path().parent),
                initialfile="config.yml",
                filetypes=[("YAML config", "*.yml *.yaml")],
            )
            if not filename:
                return
            tunnel = (
                simpledialog.askstring("Tunnel", "Tunnel name or ID (optional):", parent=self.root)
                or ""
            )
            try:
                session.create_default(Path(filename), tunnel.strip())
            except ConfigError as exc:
                messagebox.showerror("cftcfg", str(exc))
                return
            self.refresh()
            self._set_status(f"created {filename}")

        def toggle_path(self) -> None:
            integrator = PathIntegrator(Path(__file__), settings)
            try:
                if self.path_var.get():
                    message = integrator.enable()
                    messagebox.showinfo(
                        "cftcfg",
                        f"PATH integration enabled.\n{message}\n\n"
                        "Open a new terminal for the change to take effect.",
                    )
                else:
                    message = integrator.disable()
                    messagebox.showinfo("cftcfg", f"PATH integration disabled.\n{message}")
            except (OSError, ConfigError) as exc:
                self.path_var.set(integrator.status().installed)
                messagebox.showerror("cftcfg", str(exc))

        def doctor(self) -> None:
            code = cmd_doctor(argparse.Namespace(config=None), settings)
            self._set_status(f"doctor finished (exit code {code}) - see console output")
            messagebox.showinfo(
                "cftcfg doctor",
                "Doctor report was printed to the console.\nLaunch cftcfg from a terminal to see it.",
            )

        def on_close(self) -> None:
            if session.dirty:
                answer = messagebox.askyesnocancel(
                    "cftcfg", "You have unsaved changes. Save before exiting?"
                )
                if answer is None:
                    return
                if answer:
                    try:
                        session.save()
                    except ConfigError as exc:
                        messagebox.showerror("cftcfg", str(exc))
                        return
            self.root.destroy()

        def run(self) -> int:
            self.root.mainloop()
            return 0

    return CftcfgGui()


TOP_HELP = f"""cftcfg {APP_VERSION} - Cloudflare Tunnel (cloudflared) configuration manager

usage:
    cftcfg                 launch the interactive TUI (default)
    cftcfg tui             launch the interactive TUI
    cftcfg gui             launch the graphical interface (tkinter)
    cftcfg cli <command>   non-interactive CLI (run 'cftcfg cli -h' for commands)
    cftcfg --version       print version
"""


def main(argv: Optional[list[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ("-h", "--help", "help"):
        cprint(TOP_HELP)
        return 0
    if argv and argv[0] in ("-V", "--version", "version"):
        cprint(f"{APP_NAME} {APP_VERSION}")
        return 0

    mode = "tui"
    rest = argv
    if argv and argv[0] in ("tui", "gui", "cli"):
        mode = argv[0]
        rest = argv[1:]
    elif argv:
        known = {
            "init",
            "list",
            "add",
            "edit",
            "remove",
            "set-catch-all",
            "validate",
            "backup",
            "backups",
            "restore",
            "path",
            "settings",
            "doctor",
            "scan",
        }
        if argv[0] in known:
            mode = "cli"

    if mode == "cli":
        return run_cli(rest)

    settings = Settings()
    explicit = None
    if rest and rest[0] == "--config" and len(rest) > 1:
        explicit = rest[1]
    try:
        session = resolve_session(settings, explicit)
    except ConfigError as exc:
        emit_error(str(exc))
        return 1

    if mode == "gui":
        try:
            return run_gui(session, settings)
        except ImportError:
            emit_error("tkinter is not available on this Python installation")
            return 1
    return run_tui(session, settings)


if __name__ == "__main__":
    sys.exit(main())