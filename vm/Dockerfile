# v86 公式の tools/docker/alpine/Dockerfile をもとにしている。
FROM docker.io/i386/alpine:3.21.0

ENV KERNEL=virt
ENV ADDPKGS="bash git nano less file"

RUN apk add openrc alpine-base agetty alpine-conf linux-$KERNEL linux-firmware-none $ADDPKGS

RUN sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab
RUN echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab
RUN echo "root:" | chpasswd
RUN sed -i 's#^\(root:.*\):/bin/[a-z]*$#\1:/bin/bash#' /etc/passwd && grep -q '^root:.*:/bin/bash$' /etc/passwd

RUN setup-hostname localhost

# https://wiki.alpinelinux.org/wiki/Alpine_Linux_in_a_chroot#Preparing_init_services
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add $i boot; done
RUN rc-update add killprocs shutdown

# Generate initramfs with 9p modules
RUN mkinitfs -F "base virtio 9p" $(cat /usr/share/kernel/$KERNEL/kernel.release)

COPY rootfs/ /
COPY home/bash_profile /root/.bash_profile
COPY home/gitconfig /root/.gitconfig
