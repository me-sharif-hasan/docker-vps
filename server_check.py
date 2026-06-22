#!/usr/bin/env python3
"""
SSH into server, check deployment, and upload service account file
"""
import subprocess
import sys
import os

HOST = "serverkitlabs.iishanto.com"
USER = "root"
PASSWORD = "Mrs. Shanto 05 Love"

def run_command(cmd):
    """Run shell command and return output"""
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode

def ssh_command(cmd):
    """Execute command on remote server via SSH using sshpass"""
    full_cmd = f"sshpass -p '{PASSWORD}' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {USER}@{HOST} \"{cmd}\""
    stdout, stderr, code = run_command(full_cmd)
    return stdout, stderr, code

def scp_upload(local_file, remote_path):
    """Upload file to server using scp"""
    cmd = f"sshpass -p '{PASSWORD}' scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {local_file} {USER}@{HOST}:{remote_path}"
    stdout, stderr, code = run_command(cmd)
    return stdout, stderr, code

def main():
    print("=" * 70)
    print("ServerKit Labs — Server Check & Upload")
    print("=" * 70)
    print()

    # Check if sshpass exists
    stdout, stderr, code = run_command("which sshpass")
    if code != 0:
        print("⚠️  sshpass not found locally. Cannot SSH to server.")
        print("   On your local machine, install: apt-get install sshpass")
        return

    # 1. Check server connectivity
    print("🔌 Testing SSH connection...")
    stdout, stderr, code = ssh_command("echo 'Connected'")
    if code != 0:
        print(f"❌ SSH connection failed: {stderr}")
        return
    print("✅ SSH connection OK")
    print()

    # 2. Check deployed version
    print("📁 Checking deployed code...")
    stdout, stderr, code = ssh_command("cd ~/docker-vps && git log --oneline -3")
    if code == 0:
        print("Recent commits:")
        print(stdout)
    else:
        print("⚠️  No git repo found")
    print()

    # 3. Check service account files on server
    print("🔐 Checking service account files...")
    stdout, stderr, code = ssh_command("ls -la ~/docker-vps/service*.json 2>/dev/null || echo 'No service account files found'")
    print(stdout)
    print()

    # 4. Check if new service account is needed
    print("📤 Uploading serviceaccount-new.json...")
    local_file = "serviceaccount-new.json"
    remote_path = "~/docker-vps/serviceaccount-new.json"

    if not os.path.exists(local_file):
        print(f"❌ {local_file} not found in current directory")
        return

    stdout, stderr, code = scp_upload(local_file, remote_path)
    if code == 0:
        print(f"✅ {local_file} uploaded successfully")
    else:
        print(f"❌ Upload failed: {stderr}")
        return
    print()

    # 5. Verify upload
    print("✓ Verifying upload...")
    stdout, stderr, code = ssh_command("ls -lh ~/docker-vps/serviceaccount-new.json")
    if code == 0:
        print(stdout)
    else:
        print("❌ Verification failed")
        return
    print()

    # 6. Check PM2 status
    print("🔄 PM2 Status...")
    stdout, stderr, code = ssh_command("pm2 list")
    print(stdout if stdout else "No services running")
    print()

    # 7. Check latest deployed code for fallback logic
    print("🔍 Checking for fallback logic in auth.js...")
    stdout, stderr, code = ssh_command("grep -c 'serviceaccount-new' ~/docker-vps/auth.js || echo '0'")
    count = stdout.strip()
    if count != '0':
        print("✅ Fallback logic found in deployed code")
    else:
        print("⚠️  Fallback logic NOT found - may need to update code on server")
    print()

    # 8. Recommend actions
    print("=" * 70)
    print("NEXT STEPS:")
    print("=" * 70)
    print("1. ✅ File uploaded to server")
    print("2. Pull latest code: git fetch origin && git checkout -f origin/main")
    print("3. Restart service: pm2 restart serverkit-labs")
    print("4. Verify toggle switch shows on dashboard")
    print()

if __name__ == "__main__":
    main()
