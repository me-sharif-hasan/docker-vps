FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd \
    systemd-sysv \
    dbus \
    openssh-server \
    curl \
    wget \
    vim \
    nano \
    git \
    htop \
    net-tools \
    iputils-ping \
    dnsutils \
    procps \
    sudo \
    ca-certificates \
    bash \
    tar \
    gzip \
    unzip \
    lsof \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Mask heavy/irrelevant units — keep only what a real server needs
RUN systemctl mask \
    getty@tty1.service \
    getty-static.service \
    dev-hugepages.mount \
    sys-fs-fuse-connections.mount \
    systemd-update-utmp.service \
    systemd-update-utmp-runlevel.service \
    systemd-logind.service \
    systemd-remount-fs.service \
    systemd-udev-trigger.service \
    systemd-udevd.service \
    apt-daily.timer \
    apt-daily-upgrade.timer \
    apt-daily.service \
    apt-daily-upgrade.service \
    e2scrub_reap.service \
    fstrim.timer \
    motd-news.timer \
    ua-timer.timer \
    unattended-upgrades.service \
    2>/dev/null || true

# Create lab user with sudo access
RUN useradd -m -s /bin/bash labuser \
    && echo "labuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && passwd -d labuser

# SSH setup — key auth only
RUN mkdir -p /var/run/sshd \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/.*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/.*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && systemctl enable ssh

# Prepare SSH dir for labuser
RUN mkdir -p /home/labuser/.ssh \
    && chmod 700 /home/labuser/.ssh \
    && chown labuser:labuser /home/labuser/.ssh

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22

STOPSIGNAL SIGRTMIN+3

CMD ["/entrypoint.sh"]
