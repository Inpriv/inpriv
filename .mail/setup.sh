#!/bin/bash
# ============================================================================
# INPRIV — Automated Setup Script
# Configures Python backend, Environment Variables, and Cloudflare Tunnel
# ============================================================================

set -e

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}   INPRIV Zero-Knowledge Mail — Automated Setup            ${NC}"
echo -e "${CYAN}============================================================${NC}"
echo ""

# 1. Gather Input
read -p "Enter local port for FastAPI backend [8000]: " PORT
PORT=${PORT:-8000}

read -p "Enter your target domain (e.g., mail.inpriv.xyz): " HOSTNAME
HOSTNAME=${HOSTNAME:-mail.inpriv.xyz}

read -p "Enter a name for your Cloudflare Tunnel [inpriv]: " TUNNEL_NAME
TUNNEL_NAME=${TUNNEL_NAME:-inpriv}

echo ""
echo -e "${YELLOW}[*] Generating secure secrets...${NC}"
JWT_SECRET=$(openssl rand -hex 32)
INBOUND_SECRET=$(openssl rand -hex 32)

# 2. Write .env file
echo -e "${GREEN}[*] Writing .env configuration...${NC}"
cat <<EOF > .env
# Server Config
PORT=$PORT

# Security
JWT_SECRET=$JWT_SECRET
INBOUND_EMAIL_SECRET=$INBOUND_SECRET

# CORS
CORS_ORIGINS=https://$HOSTNAME

# Database
DB_PATH=inpriv.db
EOF

# 3. Python Setup
echo -e "${YELLOW}[*] Setting up Python environment...${NC}"
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
source .venv/bin/activate

echo -e "${GREEN}[*] Installing Python dependencies...${NC}"
pip install --upgrade pip > /dev/null
pip install fastapi "uvicorn[standard]" sqlmodel "python-jose[cryptography]" argon2-cffi pydantic-settings cryptography > /dev/null

# 4. Cloudflare Setup
echo ""
echo -e "${YELLOW}[*] Checking for cloudflared...${NC}"
if ! command -v cloudflared &> /dev/null; then
    echo -e "${RED}[!] cloudflared not found. Please install it first:${NC}"
    echo -e "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/"
    exit 1
fi

echo -e "${GREEN}[*] Logging into Cloudflare (a browser will open)...${NC}"
cloudflared tunnel login

echo -e "${GREEN}[*] Creating Tunnel: $TUNNEL_NAME...${NC}"
# Create tunnel and capture output to extract ID
TUNNEL_OUTPUT=$(cloudflared tunnel create $TUNNEL_NAME)
TUNNEL_ID=$(echo "$TUNNEL_OUTPUT" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')

if [ -z "$TUNNEL_ID" ]; then
    echo -e "${RED}[!] Failed to create tunnel or extract ID. It might already exist.${NC}"
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
    if [ -z "$TUNNEL_ID" ]; then
        echo -e "${RED}[!] Could not find existing tunnel ID. Exiting.${NC}"
        exit 1
    fi
    echo -e "${YELLOW}[*] Found existing tunnel ID: $TUNNEL_ID${NC}"
fi

echo -e "${GREEN}[*] Configuring DNS route for $HOSTNAME...${NC}"
cloudflared tunnel route dns $TUNNEL_NAME $HOSTNAME

# Create cloudflared config file
echo -e "${GREEN}[*] Generating config.yml...${NC}"
mkdir -p .cloudflared
cat <<EOF > .cloudflared/config.yml
tunnel: $TUNNEL_ID
credentials-file: ./.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF

echo ""
echo -e "${CYAN}============================================================${NC}"
echo -e "${GREEN} Setup Complete! ${NC}"
echo -e "${CYAN}============================================================${NC}"
echo ""
echo -e "Next steps:"
echo -e " 1. Go to your Cloudflare Dashboard -> Email -> Routing"
echo -e " 2. Enable Email Routing for inpriv.xyz (Cloudflare sets MX records)."
echo -e " 3. Go to the 'Routing rules' tab -> Catch-all address -> Send to a Worker."
echo -e " 4. Create a new Worker using the JS code from the top of main.py."
echo -e " 5. Add the Environment Variable INBOUND_EMAIL_SECRET to the Worker with this value:"
echo -e "    ${YELLOW}$INBOUND_SECRET${NC}"
echo ""
echo -e " Run ${GREEN}./start.sh${NC} to start the backend and tunnel."