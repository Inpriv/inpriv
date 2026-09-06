// ─────────────────────────────────────────────────────────────────────────────
// Inpriv Check — static heuristic analysis engine
// Copyright (c) 2026 Inpriv Labs — MIT License
//
// Dependency-free, regex + combo based malware indicator scanner. Works on
// source text for javascript, python, shell, powershell, batch, vba, php and
// more. Every finding carries a severity, a category, a human message and
// the line number it was found on. Rules are tuned against real malware
// samples (reverse shells, ransomware droppers, info-stealers, miners,
// obfuscated payloads) and kept conservative to avoid crying wolf on
// legit code.
// ─────────────────────────────────────────────────────────────────────────────

export const WEIGHTS = { critical: 8, high: 5, medium: 3, low: 1, info: 0 };

export const CATEGORY_LABELS = {
  obfuscation: "Obfuscation",
  dynamic_execution: "Dynamic execution",
  reverse_shell: "Reverse shell",
  exfiltration: "Data exfiltration",
  credentials: "Credential theft",
  persistence: "Persistence",
  defense_evasion: "Defense evasion",
  ransomware: "Ransomware / destruction",
  mining: "Crypto mining",
  lolbins: "Living-off-the-land abuse",
  macro: "Office macro abuse",
  web_injection: "Web injection",
  phishing: "Phishing",
  threat_text: "Coercive text",
  misc: "Suspicious pattern",
};

const LANG_ALIASES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", pyw: "python",
  sh: "shell", bash: "shell", zsh: "shell",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  bat: "batch", cmd: "batch",
  vba: "vba", vbs: "vba", bas: "vba",
  php: "php",
  rb: "ruby", pl: "perl", pm: "perl",
  java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp",
  go: "go", rs: "rust",
  html: "html", htm: "html", jsphp: "php",
  sql: "sql", json: "json", md: "markdown", txt: "plain", csv: "plain",
};

// heuristics first line:  #!/usr/bin/env python3 → python
function languageFromName(name) {
  if (!name) return "plain";
  const base = String(name).split("/").pop().split(".").pop().toLowerCase();
  // double-ext check handled elsewhere
  return LANG_ALIASES[base] || "plain";
}

function detectLanguage(name, code) {
  const fromName = languageFromName(name || "");
  if (fromName !== "plain") return fromName;
  const head = String(code || "").slice(0, 400);
  if (/^#!\s*\/.*\b(python|python3)/m.test(head)) return "python";
  if (/^#!\s*\/.*\b(bash|zsh|sh)\b/m.test(head)) return "shell";
  if (/^#!\s*\/.*\bnode\b/m.test(head)) return "javascript";
  if (/^#!\s*\/.*\b(php|perl|ruby)\b/m.test(head)) return head.includes("php") ? "php" : (head.includes("perl") ? "perl" : "ruby");
  return "plain";
}

// ── rule table ───────────────────────────────────────────────────────────────
// sev: critical | high | medium | low | info
// langs: null = all languages, ["js"] = only those
// minCount: fire once when the pattern matches at least N times
const RULES = [
  // ── obfuscation ──────────────────────────────────────────────────────────
  { id: "obf_base64_decode", sev: "medium", cat: "obfuscation", langs: null,
    name: "Base64 decode in code",
    desc: "Base64 decoding is a classic way to hide payloads. Check what is being decoded before running.",
    re: /(atob\s*\(|btoa\s*\(|Base64\.decode|FromBase64String\s*\(|base64\s+(-d|--decode)\b|from\s+base64\b|decodeURIComponent\s*\()/gi },
  { id: "obf_base64_blob", sev: "medium", cat: "obfuscation", langs: null, minCount: 1,
    name: "Large Base64 blob",
    desc: "A very long Base64-encoded string can hide an embedded executable or script.",
    re: /[A-Za-z0-9+/]{200,}={0,2}/g },
  { id: "obf_hex_escape", sev: "medium", cat: "obfuscation", langs: null, minCount: 8,
    name: "Heavy hex escaping",
    desc: "Many \\xNN hex escapes usually mean the code was packed or obfuscated.",
    re: /\\x[0-9a-fA-F]{2}/g },
  { id: "obf_unicode_escape", sev: "medium", cat: "obfuscation", langs: null, minCount: 10,
    name: "Heavy unicode escapes",
    desc: "A large number of \\u00XX escapes is a common obfuscation technique.",
    re: /\\u00[0-9a-fA-F]{2}/g },
  { id: "obf_charcode", sev: "high", cat: "obfuscation", langs: ["javascript", "typescript"],
    name: "String.fromCharCode payload",
    desc: "Building strings from char codes is a standard way to hide malicious strings from scanners.",
    re: /String\.fromCharCode\s*\(\s*\d{2,3}(?:\s*,\s*\d{2,3}){4,}/g },
  { id: "obf_vbe", sev: "high", cat: "obfuscation", langs: ["vba", "batch"],
    name: "Encoded script header (#@~)",
    desc: "The '#@~^' marker identifies a Microsoft Script Encoder encoded block — commonly used to hide malware.",
    re: /#\s*@~\^[A-Za-z0-9+/=]{20,}/g },
  { id: "obf_fromhex", sev: "high", cat: "obfuscation", langs: ["python"],
    name: "Hex/bytes payload construction",
    desc: "exec/eval fed fromhex(), bytes() or chr() sequences is the standard way Python stealer payloads hide themselves.",
    re: /(?:exec|eval)\s*\(\s*(?:bytes|chr|compile|marshal|str\s*\(\s*bytes)|bytes\.fromhex|marshal\.loads|__import__\s*\(\s*['"]builtins['"]\s*\)/gi },
  { id: "obf_pickle", sev: "high", cat: "obfuscation", langs: ["python"],
    name: "pickle.loads()",
    desc: "pickle.loads() on untrusted input executes arbitrary code when the pickle is built for it.",
    re: /pickle\.loads\s*\(/gi },

  // ── dynamic execution ────────────────────────────────────────────────────
  { id: "exec_eval", sev: "high", cat: "dynamic_execution", langs: ["javascript", "typescript", "python", "php", "ruby", "perl"],
    name: "eval() usage",
    desc: "eval() runs strings as code. Malware commonly uses it to decrypt and execute hidden payloads.",
    re: /\beval\s*\(/gi },
  { id: "exec_function_ctor", sev: "high", cat: "dynamic_execution", langs: ["javascript", "typescript"],
    name: "new Function(...)",
    desc: "The Function constructor is eval() in disguise and is frequently used by obfuscators.",
    re: /new\s+Function\s*\(/gi },
  { id: "exec_child_process", sev: "high", cat: "dynamic_execution", langs: ["javascript", "typescript"],
    name: "child_process execution",
    desc: "Spawning OS processes from script code is a common malware behaviour (droppers, persistence).",
    re: /(?:child_process|node:child_process)[\s\S]{0,60}?\.(exec|spawn|execFile|fork)|(?:^|[^.\w])(?:exec|execSync|spawnSync|spawn|fork)\s*\(/gi },
  { id: "exec_shell_true", sev: "medium", cat: "dynamic_execution", langs: ["python"],
    name: "subprocess with shell=True",
    desc: "shell=True pipes the command through the system shell, enabling command chaining and shell metacharacters.",
    re: /shell\s*=\s*True/gi },
  { id: "exec_os_system", sev: "high", cat: "dynamic_execution", langs: ["python"],
    name: "os.system() / os.popen()",
    desc: "os.system() and os.popen() run OS commands from Python — typical for droppers and backdoors.",
    re: /\bos\.(?:system|popen)\s*\(/gi },
  { id: "exec_subprocess", sev: "high", cat: "dynamic_execution", langs: ["python"],
    name: "subprocess execution",
    desc: "subprocess.run/Popen/call executes external programs — check the command line for anything suspicious.",
    re: /subprocess\.(?:run|Popen|call|check_output|check_call)\s*\(/gi },
  { id: "exec_php", sev: "high", cat: "dynamic_execution", langs: ["php"],
    name: "PHP command execution",
    desc: "system(), exec(), shell_exec() and friends execute OS commands from PHP — a classic webshell signature.",
    re: /\b(?:system|exec|shell_exec|passthru|proc_open|pcntl_exec)\s*\(/gi },
  { id: "exec_iex", sev: "high", cat: "dynamic_execution", langs: ["powershell"],
    name: "Invoke-Expression",
    desc: "IEX / Invoke-Expression evaluates strings as PowerShell — the #1 way encoded payloads are run.",
    re: /Invoke-Expression|\bIEX\s*[\( ]/gi },
  { id: "exec_ps_encoded", sev: "critical", cat: "obfuscation", langs: null,
    name: "PowerShell -EncodedCommand",
    desc: "-EncodedCommand (or -enc with a Base64 blob) is the classic signature of a PowerShell malware launcher.",
    re: /-EncodedCommand\b|(?:powershell|pwsh)(?:\.exe)?[^\n]{0,70}(?:-enc\b|-encodedcommand\b)|-enc\s+[A-Za-z0-9+/]{16,}={0,2}/gi },
  { id: "exec_cmd_c", sev: "medium", cat: "dynamic_execution", langs: ["batch", "powershell"],
    name: "cmd /c invocation",
    desc: "cmd /c runs a command in a new shell — harmless alone, but often the wrapper for a malicious command.",
    re: /\bcmd(?:\.exe)?\s*\/[ckr]\s+/gi },
  { id: "exec_download_exec", sev: "critical", cat: "dynamic_execution", langs: null,
    name: "Download then execute",
    desc: "Downloading code and immediately piping it into a shell/script interpreter is a universal malware pattern.",
    re: /(?:DownloadString|DownloadFile|Invoke-WebRequest|New-Object\s+(?:Net\.)?WebClient)[\s\S]{0,120}?(?:IEX\s*\(|Start-Process|^\s*\|)/gi },
  { id: "exec_curl_pipe_sh", sev: "critical", cat: "dynamic_execution", langs: ["shell", "batch"],
    name: "curl|sh style one-liner",
    desc: "Streaming a remote script straight into sh/bash/powershell executes whatever the URL returns.",
    re: /\b(?:curl|wget)\s+[^\n]{0,200}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|cmd)\s*$/gim },
  { id: "exec_ps_dl", sev: "critical", cat: "dynamic_execution", langs: ["powershell", "batch"],
    name: "PowerShell download cradle",
    desc: "IEX (New-Object Net.WebClient).DownloadString('...') is the canonical PowerShell malware loader.",
    re: /IEX\s*\(\s*New-Object\s+(?:Net\.)?WebClient\s*\)\s*\.\s*DownloadString|powershell\s+[^\n]{0,160}(?:DownloadString|IEX|iex)/gi },
  { id: "exec_wmic_create", sev: "high", cat: "lolbins", langs: ["batch", "powershell"],
    name: "wmic process call create",
    desc: "wmic process call create launches a binary — a common LOLBin technique used by malware.",
    re: /wmic\s+process\s+call\s+create\s+/gi },
  { id: "exec_process_start", sev: "high", cat: "dynamic_execution", langs: ["powershell", "javascript", "java", "c", "cpp", "go"],
    name: "Process spawn",
    desc: "Starting a new process from code. Fine in apps, but a core primitive of droppers and persistence.",
    re: /(?:Process|System\.Diagnostics\.Process)\.Start\s*\(|Start-Process\s+/gi },

  // ── reverse shells / remote control ──────────────────────────────────────
  { id: "shell_devtcp", sev: "critical", cat: "reverse_shell", langs: ["shell", "python"],
    name: "/dev/tcp shell",
    desc: "Writing to /dev/tcp from a shell script is a textbook reverse-shell technique.",
    re: /\/dev\/tcp\//g },
  { id: "shell_bash_i", sev: "critical", cat: "reverse_shell", langs: ["shell"],
    name: "bash -i redirect",
    desc: "'bash -i >& /dev/tcp/...' is the most common reverse-shell one-liner in the wild.",
    re: /bash\s+-i\s*[>&|]/gi },
  { id: "shell_nc", sev: "critical", cat: "reverse_shell", langs: ["shell"],
    name: "netcat with -e/--exec",
    desc: "nc -e /bin/sh (or ncat --exec) hands a shell over the network on connect.",
    re: /\b(?:nc|ncat)\s+[^\n]{0,80}\s(?:-e\s|--exec\s|--sh-exec\s)/gi },
  { id: "shell_socat", sev: "critical", cat: "reverse_shell", langs: ["shell"],
    name: "socat exec/system",
    desc: "socat with exec: or system: attaches a shell to a TCP socket.",
    re: /socat\s+[^\n]*(?:exec:|system:)/gi },
  { id: "shell_pty_spawn", sev: "high", cat: "reverse_shell", langs: ["python"],
    name: "PTY spawn",
    desc: "pty.spawn() / subprocess + pty combos appear in interactive shells and terminal-based backdoors.",
    re: /pty\.(?:spawn|openpty|fork)\s*\(/g },

  // ── exfiltration ─────────────────────────────────────────────────────────
  { id: "exfil_raw_ip_url", sev: "high", cat: "exfiltration", langs: null,
    name: "HTTP URL with raw IP",
    desc: "Calls to http(s)://<ip> instead of a domain are typical of command & control or data exfiltration.",
    re: /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?/g },
  { id: "exfil_raw_ws", sev: "high", cat: "exfiltration", langs: null,
    name: "WebSocket to raw IP",
    desc: "WebSocket connections to raw IP addresses are a common C2 channel.",
    re: /["'`]wss?:\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?["'`]/g },
  { id: "exfil_webhooks", sev: "high", cat: "exfiltration", langs: null,
    name: "Chat/webhook bot endpoint",
    desc: "Discord/Telegram/Slack webhooks and bot APIs are the favourite drop zones of info-stealers.",
    re: /discord(?:app)?\.com\/api\/webhooks\/|api\.telegram\.org\/bot\d{6,}:|hooks\.slack\.com\/services\//gi },
  { id: "exfil_anonpaste", sev: "medium", cat: "exfiltration", langs: null,
    name: "Anonymous paste/upload host",
    desc: "Uploading to anonymous paste or file hosts (pastebin, transfer.sh, catbox…) is a common exfil route.",
    re: /(?:pastebin\.com\/api|dpaste\.org|transfer\.sh|0x0\.st|tmpfiles\.org|catbox\.moe|uguu\.se|anonfiles\.com|krakenfiles\.com|gofile\.io\/|paste\.ee\/|rentry\.co)/gi },
  { id: "exfil_beacon_loop", sev: "medium", cat: "exfiltration", langs: ["javascript", "typescript"],
    name: "Periodic beacon to network",
    desc: "A setInterval/setTimeout that keeps calling the network can be a C2 heartbeat or analytics-in-disguise.",
    re: /set(?:Interval|Timeout)\s*\([^;]{0,200}(?:fetch|sendBeacon|XMLHttpRequest|WebSocket)/gi },
  { id: "exfil_onion", sev: "medium", cat: "exfiltration", langs: null,
    name: ".onion address",
    desc: "Hardcoded .onion addresses route traffic to the Tor network — common in C2 and darknet tooling.",
    re: /[a-z2-7]{16}\.onion\b/gi },
  { id: "c2_random_domain", sev: "medium", cat: "exfiltration", langs: null,
    name: "Long random-looking domain",
    desc: "Long gibberish domains are a frequent signature of fast-flux C2 infrastructure.",
    re: /["'`]https?:\/\/[a-z0-9]{16,}\.(?:com|net|org|top|xyz|ru|info|club|online|site|icu|gq|ml|tk|cf|ga)(?:\/|["'`])/gi },

  // ── credential theft ─────────────────────────────────────────────────────
  { id: "cred_key_files", sev: "critical", cat: "credentials", langs: null,
    name: "Private key / credential files",
    desc: "Reads or references SSH private keys, .aws/credentials, .git-credentials or .netrc — classic stealer targets.",
    re: /\.ssh\/|id_rsa\b|id_dsa\b|id_ed25519\b|\.aws\/credentials|\.git-credentials|\.netrc\b|\.pgpass\b/g },
  { id: "cred_store_access", sev: "high", cat: "credentials", langs: null,
    name: "Password vault / store access",
    desc: "Accessing browser login stores, DPAPI, keychains or password managers from script code is a stealer signature.",
    re: /login\s+data(?:\.sqlite)?|cookies\.sqlite|CryptUnprotectData|dpapi|keychain|password-store|pass\s+show\b|Login\s*Items|Get-ItemProperty\s+[^\n]{0,80}(?:password|login)/gi },
  { id: "cred_mimikatz", sev: "critical", cat: "credentials", langs: null,
    name: "Credential dumping tool",
    desc: "Mimikatz / sekurlsa are offensive tools for dumping passwords from memory. Almost never legit.",
    re: /mimikatz|sekurlsa/gi },
  { id: "cred_keylog", sev: "critical", cat: "credentials", langs: null,
    name: "Keyboard hook / keylogger",
    desc: "Global keyboard hooks, keypress capture or pynput.keyboard record everything the user types.",
    re: /GetAsyncKeyState|SetWindowsHookEx|WH_KEYBOARD|RegisterHotKey|pynput\.keyboard|keyboard\.(?:on_press|record)\b|onkeypress\s*=\s*[^>]{0,100}?(?:fetch|sendBeacon|XMLHttpRequest|Image)/gi },
  { id: "cred_clipboard", sev: "medium", cat: "credentials", langs: null,
    name: "Clipboard reading",
    desc: "Reading the clipboard programmatically (without a user paste gesture) is a stealer staple.",
    re: /navigator\.clipboard\.read(?:Text)?\s*\(|pyperclip\.paste|win32clipboard|Get-Clipboard\b/g },
  { id: "cred_screenshot", sev: "medium", cat: "credentials", langs: null,
    name: "Screen capture",
    desc: "Programmatic screenshots can harvest 2FA codes, passwords and wallet keys from the screen.",
    re: /mss\.(?:mss|tool)|ImageGrab\.grab|pyautogui\.screenshot|html2canvas|captureStream\s*\(/gi },
  { id: "cred_form_harvest", sev: "high", cat: "phishing", langs: ["javascript", "typescript", "html"],
    name: "Form submit → network",
    desc: "A submit handler that immediately pushes captured input to the network is a phishing-harvest pattern.",
    re: /(?:addEventListener\s*\(\s*['"]submit|onsubmit\s*=\s*)[^}]{0,250}(?:fetch\s*\(|sendBeacon|XMLHttpRequest|WebSocket)/gi },
  { id: "cred_pin_read", sev: "medium", cat: "phishing", langs: ["javascript", "typescript"],
    name: "Reading password fields",
    desc: "Script code reading password/pin/card field values — verify it is only used for validation.",
    re: /getElementById\s*\(\s*['"][^'"]*(?:pass|pin|cc|card)['"]\s*\)\s*\.\s*value|querySelector\s*\(\s*['"][^'"]*(?:password|pin|ccnum)['"]\s*\)\s*\.\s*value/gi },

  // ── persistence ──────────────────────────────────────────────────────────
  { id: "persist_registry_run", sev: "critical", cat: "persistence", langs: null,
    name: "Registry Run key write",
    desc: "Writing to HKCU/HKLM ...\\CurrentVersion\\Run makes code start on every logon — standard persistence.",
    re: /(?:HKCU|HKLM|HKEY_[A-Z_]+):?\\[^\]\n]{0,80}CurrentVersion\\Run(?:Once)?/gi },
  { id: "persist_startup", sev: "high", cat: "persistence", langs: null,
    name: "Startup folder / autorun",
    desc: "Dropping files into the Windows Startup folder or shell:startup persists on next logon.",
    re: /Start\s*Menu\\Programs\\Startup|shell:startup|AppData\\Roaming\\Microsoft\\Windows\\Start\s*Menu/g },
  { id: "persist_cron", sev: "high", cat: "persistence", langs: ["shell"],
    name: "Cron persistence",
    desc: "@reboot / /etc/cron entries re-run code on every boot — a Unix persistence favourite.",
    re: /@reboot\b|\/etc\/cron\.(?:d|daily|hourly|weekly|monthly)/g },
  { id: "persist_scheduler", sev: "high", cat: "persistence", langs: null,
    name: "Scheduled task / service install",
    desc: "schtasks /create, sc create, systemctl enable, launchd and similar install long-lived execution.",
    re: /schtasks\s+\/create|sc\s+create\b|New-Service\b|Register-ScheduledTask|systemctl\s+(?:enable|start)\s|launchctl\s+(?:load|submit)\b|\/etc\/systemd\/system/g },
  { id: "persist_wmi", sev: "high", cat: "persistence", langs: ["powershell", "batch", "c", "cpp"],
    name: "WMI event subscription",
    desc: "__EventFilter / __EventConsumer pairs are an advanced (and very malware-y) persistence technique.",
    re: /__EventFilter|__EventConsumer|CommandLineEventConsumer|ActiveScriptEventConsumer|Set-WmiInstance/g },
  { id: "persist_ssh_authorized", sev: "high", cat: "persistence", langs: ["shell"],
    name: "Write to authorized_keys",
    desc: "Appending an attacker public key to authorized_keys opens a permanent SSH backdoor.",
    re: /authorized_keys\s*[>|]|>>\s*[^\n]*authorized_keys|ssh-rsa\s+AAAA|ssh-ed25519\s+AAAA/g },

  // ── defense evasion ──────────────────────────────────────────────────────
  { id: "defense_disable_av", sev: "critical", cat: "defense_evasion", langs: null,
    name: "Disabling antivirus / Defender",
    desc: "Set-MpPreference -DisableRealtimeMonitoring, stopping Defender services or taskkill'ing MsMpEng is quintessential malware.",
    re: /Set-MpPreference\s+-DisableRealtimeMonitoring|DisableRealtimeMonitoring|DisableAntiSpyware|DisableAntiVirus|taskkill\s+[^\n]*(?:MsMpEng|WinDefend)|net\s+stop\s+\w*defend|Stop-Service\s+[^\n]*(?:Defender|SecurityHealth)|sc\s+stop\s+WinDefend/g },
  { id: "defense_exclusion", sev: "high", cat: "defense_evasion", langs: ["powershell"],
    name: "AV exclusion added",
    desc: "Adding Defender exclusions clears the path for the payload that follows — a very common pre-attack step.",
    re: /Add-MpPreference\s+-Exclusion(?:Path|Extension|Process)|-ExclusionPath\s+/gi },
  { id: "defense_firewall_off", sev: "high", cat: "defense_evasion", langs: null,
    name: "Firewall disabled",
    desc: "Turning off the firewall (netsh advfirewall … off) is a precursor to outbound C2 traffic.",
    re: /netsh\s+advfirewall\s+set\s+allprofiles\s+state\s+off|Set-NetFirewallProfile\s+-Enabled\s+False/g },
  { id: "defense_uac_bypass", sev: "high", cat: "defense_evasion", langs: null,
    name: "UAC bypass technique",
    desc: "fodhelper, eventvwr, sdclt, computerdefaults and SilentCleanup are abused to silently elevate privileges.",
    re: /fodhelper|eventvwr\.exe|sdclt\.exe|computerdefaults|customhost\s+InternalName|SilentCleanup\b|bypassuac/g },
  { id: "defense_antivm", sev: "medium", cat: "defense_evasion", langs: null,
    name: "VM / sandbox detection",
    desc: "Probing for virtual machines, emulators or headless browsers is common in malware that checks for analysts.",
    re: /Get-WmiObject\s+Win32_(?:ComputerSystem|BaseBoard)|wmic\s+computersystem\s+get\s+model|IsEmulator|navigator\.webdriver|(?:VMware|VirtualBox|QEMU|vbox)\s*[,;()].{0,20}(?:machine|virtual)|userAgent[\s\S]{0,60}headless/gi },

  // ── ransomware / destruction ─────────────────────────────────────────────
  { id: "ransom_shadow_delete", sev: "critical", cat: "ransomware", langs: null,
    name: "Shadow copy deletion",
    desc: "vssadmin delete shadows / wmic shadowcopy delete removes the only free recovery — a hallmark of ransomware.",
    re: /vssadmin\s+delete\s+shadows|wmic\s+shadowcopy\s+delete|Get-WmiObject\s+Win32_ShadowCopy|bcdedit\s+[^\n]*recoveryenabled/g },
  { id: "ransom_note", sev: "high", cat: "ransomware", langs: null,
    name: "Ransom note language",
    desc: "Text threatening that files are encrypted and demanding payment matches ransomware notes.",
    re: /your\s+files\s+have\s+been\s+encrypted|to\s+(?:recover|restore|decrypt)\s+your\s+files.{0,140}(?:bitcoin|monero|payment)|files\s+are\s+encrypted.{0,140}(?:bitcoin|monero)|payment\s+(?:required|must\s+be\s+made).{0,80}(?:bitcoin|within)/gi },
  { id: "ransom_disk_write", sev: "critical", cat: "ransomware", langs: ["shell"],
    name: "Direct disk overwrite",
    desc: "dd if=… of=/dev/sd* or mkfs on a raw device destroys filesystems — a wiper behaviour.",
    re: /dd\s+if=[^\n]{0,80}of=\/(?:dev\/sd|dev\/nvme|dev\/mmc|dev\/vda)|mkfs\.\w+\s+\/dev\//g },
  { id: "destruct_rm_root", sev: "high", cat: "ransomware", langs: ["shell"],
    name: "Recursive root deletion",
    desc: "rm -rf / (or / *) deletes the entire filesystem — destructive beyond any legitimate use.",
    re: /rm\s+-r[fR]+\s+(\/\s*$|\/\s*\*)|rm\s+-rf\s+[^\n]{0,40}(?:--no-preserve-root)/gim },
  { id: "destruct_format", sev: "critical", cat: "ransomware", langs: ["batch", "powershell"],
    name: "Drive format",
    desc: "format C: /Q etc. wipes partitions — the payload of a wiper or a malicious 'cleanup' script.",
    re: /(?:^|\s)format\s+[A-Za-z]:\s*\/[qfsu]|format\.com\s+[A-Za-z]:/gi },
  { id: "destruct_mass_delete", sev: "medium", cat: "ransomware", langs: null,
    name: "Mass recursive delete",
    desc: "Recursively force-deleting everything under a drive/root is destructive and rarely legitimate.",
    re: /Remove-Item\s+[^\n]{0,120}-Recurse\s+[^\n]{0,60}-Force|shutil\.rmtree\s*\(|del\s+\/[fq][^\n]{0,60}\\\*\.\*/gi },

  // ── mining ───────────────────────────────────────────────────────────────
  { id: "miner_exe", sev: "critical", cat: "mining", langs: null,
    name: "Miner executable/pool",
    desc: "xmrig, minergate, ethminer and mining-pool URLs (stratum+tcp) mean the code is (or launches) a cryptocurrency miner.",
    re: /xmrig|minergate|ethminer|nicehash|ccminer|phoenixminer|minerd\b|cpuminer|cryptonight\b|stratum\+tcp:\/\/|monerohash|hashvault|coinhive|coinimp|authedmine|webminepool|crypto-loot/gi },
  { id: "miner_browser", sev: "high", cat: "mining", langs: ["javascript", "typescript"],
    name: "Browser miner",
    desc: "startMining / Miner construction / in-page mining pools silently mine with your visitors' CPUs.",
    re: /startMining\s*\(|new\s+Miner\s*\(|CoinHive|CryptoLoot|WebMinePool|miner_loop|TotalHash\s*=|window\.Miner\s*=/gi },

  // ── living-off-the-land ──────────────────────────────────────────────────
  { id: "lolbin_mshta", sev: "high", cat: "lolbins", langs: null,
    name: "mshta remote script",
    desc: "mshta http://… runs remote JavaScript/VBScript through the HTML Application host — a powerful LOLBin.",
    re: /mshta\s+(?:javascript:|vbscript:|https?:\/\/)/gi },
  { id: "lolbin_rundll32", sev: "high", cat: "lolbins", langs: null,
    name: "rundll32 abuse",
    desc: "rundll32 calling javascript:, a remote URL or url.dll is a classic download-and-run primitive.",
    re: /rundll32\s+[^\n]{0,120}(?:url\.dll|javascript:|http|\w+\.dll,\s*(?:Start|Download))/gi },
  { id: "lolbin_regsvr32", sev: "high", cat: "lolbins", langs: null,
    name: "regsvr32 /i scrobj",
    desc: "regsvr32 /s /i:URL scrobj.dll fetches and runs script from a remote URL without writing to disk.",
    re: /regsvr32\s+\/[sinu]{1,4}\s*\/i|scrobj\.dll/gi },
  { id: "lolbin_certutil", sev: "medium", cat: "lolbins", langs: null,
    name: "certutil download/decode",
    desc: "certutil -urlcache / -decode is used to fetch and decode (often hidden Base64) payloads.",
    re: /certutil\s+-(?:urlcache|decode|decodehex)/gi },
  { id: "lolbin_bitsadmin", sev: "medium", cat: "lolbins", langs: null,
    name: "bitsadmin transfer",
    desc: "bitsadmin /transfer downloads files via BITS — a stealthy download method used by droppers.",
    re: /bitsadmin\s+\/transfer/gi },
  { id: "lolbin_msiexec", sev: "medium", cat: "lolbins", langs: null,
    name: "msiexec remote install",
    desc: "msiexec /qn /i http://… silently installs an MSI package from a remote location.",
    re: /msiexec\s+\/q[\w]*\s+\/i\s+https?:\/\//gi },
  { id: "lolbin_wscript", sev: "medium", cat: "lolbins", langs: ["batch"],
    name: "wscript launches script",
    desc: "wscript running .js/.vbs/.jse files is how many droppers bootstrap their first stage.",
    re: /wscript(?:\.exe)?\s+\S+\.(?:js|vbs|jse)\b/gi },

  // ── office macros ────────────────────────────────────────────────────────
  { id: "macro_autoopen", sev: "high", cat: "macro", langs: ["vba"],
    name: "Auto-executing macro",
    desc: "Auto_Open / Document_Open / Workbook_Open macros run the moment a document opens — the standard macro-malware entry point.",
    re: /Sub\s+(?:AutoOpen|Auto_Open|Document_Open|Workbook_Open|AutoExec|AutoClose)\b/gi },
  { id: "macro_wscript", sev: "high", cat: "macro", langs: ["vba"],
    name: "WScript.Shell / Shell in macro",
    desc: "Creating WScript.Shell or Shell in a document macro is the classic way macro malware launches processes.",
    re: /CreateObject\s*\(\s*["']WScript\.Shell["']|WScript\.Shell\b|Shell\s+["'](?:powershell|cmd|wscript|mshta)/gi },
  { id: "macro_malicious_url", sev: "high", cat: "macro", langs: ["vba"],
    name: "Macro fetches remote payload",
    desc: "A macro downloading or launching a file from a URL is a macro-dropper signature.",
    re: /(?:WinHttp|XMLHTTP|MSXML2\.XMLHTTP|URLDownloadToFile|Shell.*https?:\/\/)/gi },

  // ── web injection / phishing ─────────────────────────────────────────────
  { id: "web_iframe_inject", sev: "medium", cat: "web_injection", langs: ["javascript", "typescript", "html"],
    name: "Inline iframe injection",
    desc: "document.write / innerHTML with an iframe is how ad-injectors and malvertising embed third-party content.",
    re: /document\.write\s*\([^)]*iframe|innerHTML\s*=\s*[^;]{0,120}iframe|srcdoc\s*=/gi },
  { id: "web_remote_form", sev: "medium", cat: "phishing", langs: ["html"],
    name: "Form posts to remote host",
    desc: "An HTML form whose action points at a different host can be credential phishing.",
    re: /<form[^>]{0,200}action\s*=\s*["']https?:\/\/[^"']{5,}["']/gi },
  { id: "web_crypto_address", sev: "medium", cat: "phishing", langs: null,
    name: "Crypto address",
    desc: "A hardcoded cryptocurrency address — sometimes a ransom/`donation` payment target.",
    re: /\b(?:bc1[a-zA-HJ-NP-Z0-9]{25,62}|1[a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|4[0-9AB][1-9A-HJ-NP-Za-km-z]{93})\b/g },

  // ── coercive text ────────────────────────────────────────────────────────
  { id: "threat_coercion", sev: "medium", cat: "threat_text", langs: null,
    name: "Coercive / threatening text",
    desc: "Text that threatens to publish/delete data unless payment is made is ransom-adjacent language.",
    re: /\b(?:publish|leak|delete|destroy|release)\b[^\n]{0,90}\b(?:unless|if)\b[^\n]{0,90}\b(?:pay|payment|bitcoin|btc|monero)\b|(?:pay|send)\s+us\s+[^\n]{0,50}(?:bitcoin|btc|monero|xmr)/gi },

  // ── misc ─────────────────────────────────────────────────────────────────
  { id: "misc_double_ext", sev: "high", cat: "misc",
    name: "Disguised double extension",
    desc: "A filename ending in .pdf.exe / .jpg.js / .png.scr attempts to hide the real executable extension.",
    re: /\.(?:pdf|doc|docx|xls|xlsx|jpg|jpeg|png|zip|txt|mp4|avi|rtf|gif)\.(?:exe|scr|js|vbs|vbe|bat|cmd|msi|hta|jar|ps1|com|pif|lnk|jse|wsf)$/i, filenameOnly: true },
  { id: "misc_new_admin", sev: "high", cat: "misc", langs: null,
    name: "Account creation / admin grant",
    desc: "Creating a user or adding one to the administrators group is a backdoor-account behaviour.",
    re: /net\s+user\s+\S+\s+\S+\s*\/add|net\s+localgroup\s+administrators\s+\S+\s*\/add|useradd\s+-\S+\s+\S+|New-LocalUser\b|Add-LocalGroupMember/g },
  { id: "misc_sudoers", sev: "high", cat: "misc", langs: ["shell"],
    name: "sudoers modification",
    desc: "Writing to /etc/sudoers or /etc/passwd escalates or plants privileged users.",
    re: /\/etc\/sudoers|\/etc\/passwd\s*[>|]|chmod\s+4777/g },
];

// Combos: relations between two patterns that are suspicious only when both
// appear (implemented as functions, checked once per file).
const COMBOS = [
  {
    id: "exfil_cookie_send", sev: "high", cat: "exfiltration",
    name: "Sending cookies/local storage",
    desc: "Browser data (cookies, localStorage) is read and pushed over the network — a session-stealing pattern.",
    langs: ["javascript", "typescript"],
    net: /(?:fetch\s*\(|sendBeacon\s*\(|XMLHttpRequest|WebSocket\s*\(|axios\.(?:post|put|get)\s*\()/g,
    data: /(?:document\.cookie|localStorage|sessionStorage)/g,
    window: 320,
  },
  {
    id: "exfil_file_read_send", sev: "high", cat: "exfiltration",
    name: "Reading files and sending them",
    desc: "The code opens/reads files and posts them to a remote endpoint — a data-stealing pattern.",
    langs: ["python"],
    net: /requests\.(?:post|put|patch)\s*\(|urllib\.request[\s\S]{0,60}?\.(?:urlopen|Request)/g,
    data: /(?:open\s*\(|\bread_bytes\b|\bread\(\))/g,
    window: 400,
  },
  {
    id: "ransom_encrypt_walk", sev: "critical", cat: "ransomware",
    name: "Encryption over directory walk",
    desc: "Walking directories while encrypting files (Fernet/pyaes/AES) is the core loop of ransomware.",
    langs: ["python"],
    net: /os\.walk\s*\(|os\.listdir\s*\(/g,
    data: /(?:Fernet|pyaes|Crypto\.Cipher|rijndael|AES\.(?:new|create)|openssl\s+enc\s+-aes)/g,
    window: 1000,
  },
];

// ── engine ───────────────────────────────────────────────────────────────────

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code.charCodeAt(i) === 10) line++;
  return line;
}

function snippetAt(code, index, maxLen = 160) {
  const start = Math.max(0, index - 40);
  const end = Math.min(code.length, index + maxLen);
  let s = code.slice(start, end);
  // collapse newlines for the display snippet
  s = s.split("\n").join(" ").replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < code.length) s = s + "…";
  return s.slice(0, 200);
}

function scanOneFile(name, code) {
  const language = detectLanguage(name, code);
  const findings = [];

  // long-line detection (cheap loop, no regex)
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 4000) {
      findings.push(mkFinding({ id: "obf_single_line", severity: "info", category: "obfuscation",
        name: "Extremely long line", line: i + 1,
        message: "A single line longer than 4000 characters — usually minified or packed code.",
        snippet: lines[i].slice(0, 160) + "…" }));
    }
  }

  // filename-only rules (double extension etc.)
  const base = String(name || "").split("/").pop();
  for (const r of RULES) {
    if (!r.filenameOnly) continue;
    r.re.lastIndex = 0;
    if (r.re.test(base)) {
      findings.push(mkFinding({ id: r.id, severity: r.sev, category: r.cat, name: r.name,
        line: 1, message: r.desc, snippet: base }));
    }
  }

  // regex rules
  for (const r of RULES) {
    if (r.filenameOnly) continue;
    if (r.langs && !r.langs.includes(language)) continue;
    r.re.lastIndex = 0;
    const matches = [...code.matchAll(r.re)];
    if (r.minCount && matches.length < r.minCount) continue;
    if (matches.length === 0) continue;
    const cap = Math.min(matches.length, 10);
    for (let i = 0; i < cap; i++) {
      const m = matches[i];
      const idx = m.index;
      const line = lineOf(code, idx);
      let message = r.desc;
      if (r.minCount && matches.length > 1) {
        message = r.desc + ` (matched ${matches.length}×)`;
      }
      findings.push(mkFinding({ id: r.id, severity: r.sev, category: r.cat, name: r.name,
        line, message, snippet: snippetAt(code, idx) }));
    }
  }

  // combo rules
  for (const c of COMBOS) {
    if (c.langs && !c.langs.includes(language)) continue;
    c.net.lastIndex = 0;
    const netMatches = [...code.matchAll(c.net)];
    if (netMatches.length === 0) continue;
    c.data.lastIndex = 0;
    const dataMatches = [...code.matchAll(c.data)];
    if (dataMatches.length === 0) continue;
    // pair check within window
    let hit = null;
    for (const n of netMatches) {
      for (const d of dataMatches) {
        const dist = Math.abs(d.index - n.index);
        if (dist <= c.window) { hit = n; break; }
      }
      if (hit) break;
    }
    if (!hit) continue;
    findings.push(mkFinding({ id: c.id, severity: c.sev, category: c.cat, name: c.name,
      line: lineOf(code, hit.index), message: c.desc, snippet: snippetAt(code, hit.index) }));
  }

  // dedupe exact (id, line) duplicates
  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = f.rule + ":" + f.line;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => WEIGHTS[b.severity] - WEIGHTS[a.severity] || a.line - b.line);

  const score = unique.reduce((s, f) => s + WEIGHTS[f.severity], 0);
  return {
    path: name || "paste",
    language,
    lines: lines.length,
    findings: unique,
    score,
    verdict: verdictFor(score, unique.filter((f) => f.severity === "critical").length),
  };
}

function mkFinding({ id, severity, category, name, line, message, snippet }) {
  return { rule: id, severity, category, name, line, message, snippet };
}

export function verdictFor(score, criticalCount) {
  if (score === 0) return "clean";
  if (criticalCount >= 2) return "critical";
  if (criticalCount >= 1 || score >= 15) return "high";
  if (score >= 5) return "medium";
  return "low";
}

// Scan an array of {name, code}; returns the full report.
export function scanFiles(files) {
  const started = Date.now();
  const scanned = files.map((f) => {
    const one = scanOneFile(f.name, f.code || "");
    // stamp findings with their source path (multi-file reports)
    one.findings.forEach((x) => { x.path = one.path; });
    return one;
  });
  const all = scanned.flatMap((f) => f.findings);
  const score = all.reduce((s, x) => s + WEIGHTS[x.severity], 0);
  const criticalCount = all.filter((x) => x.severity === "critical").length;
  return {
    engine: "static",
    verdict: verdictFor(score, criticalCount),
    score,
    maxScore: Math.max(1, score),
    files: scanned,
    findings: all.slice(0, 250),
    summary: {
      files: scanned.length,
      lines: scanned.reduce((s, f) => s + f.lines, 0),
      findings: all.length,
      durationMs: Date.now() - started,
      ruleCount: RULES.length,
    },
  };
}

// Rank files by suspicion (for the VirusTotal mode: pick the worst file first).
export function rankFilesByScore(report) {
  return [...report.files].sort((a, b) => b.score - a.score);
}

export const STATIC_ENGINE_INFO = {
  rules: RULES.length,
  combos: COMBOS.length,
  categories: Object.keys(CATEGORY_LABELS).length,
};