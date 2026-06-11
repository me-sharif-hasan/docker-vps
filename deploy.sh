#!/bin/bash
set -e

echo "=== ServerKit Labs Deployment ==="
echo "Current directory: $(pwd)"
echo ""

# Navigate to deployment directory
if [ ! -d ~/docker-vps ]; then
  echo "Creating ~/docker-vps directory..."
  mkdir -p ~/docker-vps
fi

cd ~/docker-vps
echo "Working in: $(pwd)"
echo ""

# Initialize git if needed
if [ ! -d .git ]; then
  echo "Initializing git repository..."
  git init
  git remote add origin https://github.com/me-sharif-hasan/docker-vps.git
fi

# Fetch and checkout latest
echo "Fetching latest code from main branch..."
git fetch origin main
git checkout -f origin/main

echo ""
echo "=== Current deployment info ==="
echo "Latest commit:"
git log --oneline -1
echo ""

# Install dependencies
echo "Installing dependencies..."
npm install --production

echo ""
echo "=== Service Status ==="
# Check if pm2 is available
if command -v pm2 &> /dev/null; then
  echo "PM2 processes:"
  pm2 list || echo "No PM2 processes running"
  echo ""

  if pm2 list | grep -q "serverkit-labs"; then
    echo "Restarting serverkit-labs service..."
    pm2 restart serverkit-labs
  else
    echo "Starting serverkit-labs service..."
    pm2 start server.js --name serverkit-labs
  fi

  pm2 save
  echo "PM2 services saved"
else
  echo "PM2 not installed. Install with: npm install -g pm2"
  echo "Then run: pm2 start ~/docker-vps/server.js --name serverkit-labs"
fi

echo ""
echo "=== Deployment Complete ==="
echo "Server is running on port: $(grep PORT= ~/.env 2>/dev/null | cut -d= -f2 || echo '3000 (default)')"
