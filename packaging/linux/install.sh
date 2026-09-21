#!/bin/sh
# Installs the o2a2o binary and (when systemd is present) its service unit.
# Run from the extracted tarball, with root privileges: sudo ./install.sh
set -eu

prefix=${PREFIX:-/usr/local}
bin_dir="$prefix/bin"
unit_dir=/etc/systemd/system

install -d -m 0755 "$bin_dir"
install -m 0755 o2a2o "$bin_dir/o2a2o"
echo "installed $bin_dir/o2a2o"

if [ -f o2a2o.service ] && [ -d "$unit_dir" ]; then
    install -m 0644 o2a2o.service "$unit_dir/o2a2o.service"
    echo "installed $unit_dir/o2a2o.service"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload
        systemctl enable o2a2o.service
        echo "service enabled; start it with: sudo systemctl start o2a2o"
    fi
fi

echo "next: create /etc/o2a2o/o2a2o.yaml (template: o2a2o config init)"
echo "then: o2a2o serve --config /etc/o2a2o/o2a2o.yaml"
