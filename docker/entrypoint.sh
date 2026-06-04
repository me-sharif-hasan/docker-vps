#!/bin/bash
# Write SSH public key then hand off to systemd init
if [ -n "$LAB_PUBLIC_KEY" ]; then
    mkdir -p /home/labuser/.ssh
    echo "$LAB_PUBLIC_KEY" > /home/labuser/.ssh/authorized_keys
    chmod 600 /home/labuser/.ssh/authorized_keys
    chown -R labuser:labuser /home/labuser/.ssh
fi

exec /sbin/init
