FROM node:20

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Install Claude
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# ── Optional language toolchains (opt-in via build args) ─────────────────────
# node:20 is the base because Claude Code itself is an npm package and needs a
# Node runtime even in a Rust/Haskell-only project. These toolchains are layered
# on top and only installed when their build arg is "true".
#
# IMPORTANT: these download at BUILD time, BEFORE init-firewall.sh runs (the
# firewall is the container entrypoint, not part of the image build). So the
# toolchain CDNs (sh.rustup.rs, get-ghcup.haskell.org, static.rust-lang.org,
# downloads.haskell.org) do NOT need to be in the runtime allowlist — only the
# package registries you fetch from during development do (see init-firewall.sh).
# Versions are pinned to keep this one-time build-time fetch reproducible.

# Rust via rustup → ~/.cargo. cargo's build.rs runs arbitrary code at build time,
# the same class of supply-chain hole as npm postinstall; the runtime firewall
# contains it. Runtime registry domains needed: index.crates.io, static.crates.io.
ARG INSTALL_RUST=false
ARG RUST_VERSION=1.78.0
RUN if [ "$INSTALL_RUST" = "true" ]; then \
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain "${RUST_VERSION}" --profile minimal ; \
    fi
ENV PATH=$PATH:/home/node/.cargo/bin

# Haskell via GHCup → ~/.ghcup. GHC is large (image grows by several GB and the
# build takes 10-20 min) — only enable on Haskell days. Custom Setup.hs builds run
# arbitrary code, again contained at runtime. Runtime registry domain: hackage.haskell.org.
ARG INSTALL_HASKELL=false
ARG GHC_VERSION=9.6.5
ARG CABAL_VERSION=3.10.3.0
RUN if [ "$INSTALL_HASKELL" = "true" ]; then \
      export BOOTSTRAP_HASKELL_NONINTERACTIVE=1 \
             BOOTSTRAP_HASKELL_GHC_VERSION="${GHC_VERSION}" \
             BOOTSTRAP_HASKELL_CABAL_VERSION="${CABAL_VERSION}" \
             BOOTSTRAP_HASKELL_INSTALL_NO_STACK=1 ; \
      curl --proto '=https' --tlsv1.2 -sSf https://get-ghcup.haskell.org | sh ; \
    fi
ENV PATH=$PATH:/home/node/.ghcup/bin


# Copy and set up firewall script
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall
USER node
