#!/bin/bash
# Keycloak's minimal image has no curl. Use Bash builtins on the private management port.
set -euo pipefail
probe_port="${1:-9000}"
exec 3<>/dev/tcp/127.0.0.1/"${probe_port}"
printf 'HEAD /health/ready HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
IFS= read -r status <&3
[[ "$status" == HTTP/*' 200 '* ]]
