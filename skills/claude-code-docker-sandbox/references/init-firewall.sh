#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars, and pipeline failures
IFS=$'\n\t'       # Stricter word splitting

# Default-deny egress firewall for the dev container.
# Allowed: DNS, SSH, localhost, the host /24, GitHub's published IP ranges,
# plus the domains listed in the `for domain in ...` loop below.
# Everything else is REJECTed at the OS level.
#
# NOTE: this script runs as the container entrypoint (via docker-compose `command`),
# so if it `exit 1`s the container stops. A single unresolvable domain in the
# allowlist below will therefore take the whole container down — keep the list
# to domains that reliably resolve and that you actually need.

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush existing rules and delete existing ipsets
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

# First allow DNS and localhost before any restrictions
# Allow outbound DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
# Allow inbound DNS responses
iptables -A INPUT -p udp --sport 53 -j ACCEPT
# Allow outbound SSH
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
# Allow inbound SSH responses
iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Create ipset with CIDR support
ipset create allowed-domains hash:net

# Fetch GitHub meta information and aggregate + add their IP ranges
echo "Fetching GitHub IP ranges..."
# Retry: the embedded Docker DNS can fail on the very first query after container
# start (curl exit 6 "could not resolve host"); without retries `set -e` kills the
# container here, before the allowlist loop below even gets its own dig retries.
gh_ranges=$(curl -sS --retry 5 --retry-all-errors --retry-delay 2 https://api.github.com/meta || true)
if [ -z "$gh_ranges" ]; then
    echo "ERROR: Failed to fetch GitHub IP ranges"
    exit 1
fi

if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
    echo "ERROR: GitHub API response missing required fields"
    exit 1
fi

echo "Processing GitHub IPs..."
while read -r cidr; do
    if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
        echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
        exit 1
    fi
    echo "Adding GitHub range $cidr"
    ipset add allowed-domains "$cidr"
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

# ─────────────────────────────────────────────────────────────────────────────
# EDIT THIS LIST for your project. Keep it minimal.
#   registry.npmjs.org  → required for `npm install`
#   api.anthropic.com   → required for Claude Code (swap for your provider endpoint
#                         if using Bedrock/Vertex/Foundry)
#   *.cloudflare.com    → only if you deploy to Cloudflare; drop otherwise
# Add e.g. registry.yarnpkg.com, a private registry, or a runtime CDN as needed.
#
# Do NOT add sentry.io or VS Code Marketplace domains here: they can
# intermittently fail DNS and take the container down (this list is FATAL), and
# DISABLE_ERROR_REPORTING=1 in the compose file means Claude Code won't contact
# Sentry anyway. Statsig domains belong in the OPTIONAL list further below.
# Note: "statsig.anthropic.com" does NOT exist (no A record — stale info that
# circulates in old allowlists); never add it anywhere.
#
# LANGUAGE TOOLCHAINS: the compiler/runtime itself is installed at image BUILD
# time (see Dockerfile INSTALL_RUST / INSTALL_HASKELL), before this firewall
# exists — so toolchain CDNs are NOT listed here. Only the PACKAGE REGISTRIES
# fetched during development belong below. Uncomment the block for your language:
#
#   Rust (cargo):
#     "index.crates.io"      # sparse dependency index (cargo 1.70+)
#     "static.crates.io"     # crate tarball downloads
#   # "static.rust-lang.org" # only if you `rustup update`/add toolchains at runtime
#
#   Haskell (cabal):
#     "hackage.haskell.org"  # package index + tarballs
#   # "downloads.haskell.org"# only if you `ghcup install` at runtime
#
#   Go (go mod download / go get / go install):
#     "proxy.golang.org"     # module proxy (index + zips)
#     "sum.golang.org"       # checksum database, consulted on module download
# ─────────────────────────────────────────────────────────────────────────────
for domain in \
    "registry.npmjs.org" \
    "api.anthropic.com" \
    "api.cloudflare.com" \
    "dash.cloudflare.com" \
    "workers.cloudflare.com"; do
    echo "Resolving $domain..."
    # Retry: the embedded Docker DNS can intermittently time out at container
    # start (worse when several sandboxes resolve at once). A single failed dig
    # would `exit 1` and kill the container, so try a few times before giving up.
    ips=""
    for attempt in 1 2 3 4 5; do
        ips=$(dig +noall +answer +tries=2 +time=3 A "$domain" | awk '$4 == "A" {print $5}')
        [ -n "$ips" ] && break
        echo "  resolve attempt $attempt for $domain failed, retrying in 2s..."
        sleep 2
    done
    if [ -z "$ips" ]; then
        echo "ERROR: Failed to resolve $domain after 5 attempts"
        exit 1
    fi

    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "ERROR: Invalid IP from DNS for $domain: $ip"
            exit 1
        fi
        echo "Adding $ip for $domain"
        # -exist: some providers (e.g. Cloudflare) serve many hostnames from a
        # shared anycast IP, so the same IP can already be in the set from an
        # earlier domain. Without -exist, the duplicate add returns non-zero and
        # `set -e` kills the container mid-configuration.
        ipset add -exist allowed-domains "$ip"
    done < <(echo "$ips")
done

# ─────────────────────────────────────────────────────────────────────────────
# OPTIONAL domains: nice-to-have egress that must never block container start.
# The fatal list above exits 1 on a failed resolve and takes the container with
# it — the historical reason telemetry domains were excluded. Entries here log
# a WARN and continue instead.
#   - Statsig endpoints (Claude Code usage telemetry; one shared anycast IP).
#     The /model picker's flag-gated roster needs DISABLE_TELEMETRY unset in the
#     compose env, but works even without this egress (flags arrive via
#     api.anthropic.com) — these entries just let telemetry uploads succeed.
#   - Add your production hostname here too (e.g. <app>.<account>.workers.dev)
#     so the in-container agent can verify deploys (curl /health) itself.
# ─────────────────────────────────────────────────────────────────────────────
for domain in \
    "statsig.com" \
    "api.statsig.com" \
    "featuregates.org" \
    "statsigapi.net" \
    "prodregistryv2.org"; do
    echo "Resolving optional $domain..."
    ips=""
    for attempt in 1 2 3; do
        ips=$(dig +noall +answer +tries=2 +time=3 A "$domain" | awk '$4 == "A" {print $5}')
        [ -n "$ips" ] && break
        echo "  resolve attempt $attempt for optional $domain failed, retrying in 2s..."
        sleep 2
    done
    if [ -z "$ips" ]; then
        echo "WARN: optional domain $domain not resolved; continuing without it"
        continue
    fi
    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "WARN: invalid IP from DNS for optional $domain: $ip (skipped)"
            continue
        fi
        echo "Adding $ip for $domain"
        ipset add -exist allowed-domains "$ip"
    done < <(echo "$ips")
done

# Get host IP from default route
HOST_IP=$(ip route | grep default | cut -d" " -f3)
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host IP"
    exit 1
fi

HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
echo "Host network detected as: $HOST_NETWORK"

# Set up remaining iptables rules
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# Set default policies to DROP first
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# First allow established connections for already approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Then allow only specific outbound traffic to allowed domains
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - was able to reach https://example.com"
    exit 1
else
    echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

# Verify GitHub API access
if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
    exit 1
else
    echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi
