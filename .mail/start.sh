#!/bin/bash
# ============================================================================
# INPRIV — Startup Script
# Runs FastAPI Backend and Cloudflare Tunnel concurrently
# ============================================================================

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check if .env exists
if [ ! -f ".env" ]; then
    echo -e "${RED}[!] .env file not found. Please run ./setup.sh first.${NC}"
    exit 1
fi

# Check if cloudflared config exists
if [ ! -f ".cloudflared/config.yml" ]; then
    echo -e "${RED}[!] Cloudflare config not found. Please run ./setup.sh first.${NC}"
    exit 1
fi

# Export environment variables
export $(grep -v '^#' .env | xargs)

# Ensure we are in the virtual environment
if [ ! -d ".venv" ]; then
    echo -e "${RED}[!] Python virtual environment (.venv) not found. Please run ./setup.sh first.${NC}"
    exit 1
fi
source .venv/bin/activate

echo -e "${YELLOW}[*] Starting FastAPI Backend on port $PORT...${NC}"
# Start backend in background, save PID
uvicorn main:app --host 127.0.0.1 --port $PORT --proxy-headers &
BACKEND_PID=$!

# Give the backend a second to spin up
sleep 2

echo -e "${YELLOW}[*] Starting Cloudflare Tunnel...${NC}"
# Start tunnel in background, save PID
cloudflared tunnel --config .cloudflared/config.yml run &
TUNNEL_PID=$!

# Define cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}[*] Shutting down services...${NC}"
    kill $BACKEND_PID 2>/dev/null
    kill $TUNNEL_PID 2>/dev/null
    wait $BACKEND_PID 2>/dev/null
    wait $TUNNEL_PID 2>/dev/null
    echo -e "${GREEN}[*] Stopped.${NC}"
    exit 0
}

# Trap SIGINT (Ctrl+C) and SIGTERM
trap cleanup SIGINT SIGTERM

echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN} Inpriv is running! ${NC}"
echo -e "${GREEN} Backend: http://127.0.0.1:$PORT ${NC}"
echo -e "${GREEN} Tunnel:  Connected ${NC}"
echo -e "${GREEN} Press Ctrl+C to stop. ${NC}"
echo -e "${GREEN}============================================================${NC}"
echo ""

# Wait for both processes to finish (or until Ctrl+C)
wait $BACKEND_PID
wait $TUNNEL_PID