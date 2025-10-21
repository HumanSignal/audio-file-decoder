FROM ubuntu:24.04 AS stage_build

# Use latest Emscripten LTS version
ARG EMSCRIPTEN_VERSION=3.1.57
ENV EMSDK=/emsdk

# ------------------------------------------------------------------------------

RUN echo "## Start building" \
    && echo "## Update and install packages" \
    && apt-get -qq -y update \
    && apt-get -qq install -y --no-install-recommends \
        binutils \
        build-essential \
        ca-certificates \
        file \
        git \
        python3 \
        python3-pip \
    && echo "## Done"

# Clone and install Emscripten SDK
RUN echo "## Clone and install Emscripten" \
    && git clone https://github.com/emscripten-core/emsdk.git ${EMSDK} \
    && cd ${EMSDK} \
    && ./emsdk install ${EMSCRIPTEN_VERSION} \
    && echo "## Done"

# This generates configuration that contains all valid paths according to installed SDK
# TODO(sbc): We should be able to use just emcc -v here but it doesn't
# currently create the sanity file.
RUN cd ${EMSDK} \
    && echo "## Generate standard configuration" \
    && ./emsdk activate ${EMSCRIPTEN_VERSION} \
    && chmod 777 ${EMSDK}/upstream/emscripten \
    && chmod -R 777 ${EMSDK}/upstream/emscripten/cache \
    && echo "int main() { return 0; }" > hello.c \
    && ${EMSDK}/upstream/emscripten/emcc -c hello.c \
    && cat ${EMSDK}/upstream/emscripten/cache/sanity.txt \
    && echo "## Done"

# Cleanup Emscripten installation and strip some symbols
RUN echo "## Aggressive optimization: Remove debug symbols" \
    && cd ${EMSDK} && . ./emsdk_env.sh \
    # Remove debugging symbols from embedded node (extra 7MB)
    && strip -s `which node` \
    # Tests consume ~80MB disc space
    && rm -fr ${EMSDK}/upstream/emscripten/tests \
    # Fastcomp is not supported
    && rm -fr ${EMSDK}/upstream/fastcomp \
    # strip out symbols from clang (~extra 50MB disc space)
    && find ${EMSDK}/upstream/bin -type f -exec strip -s {} + || true \
    && echo "## Done"

# ------------------------------------------------------------------------------
# -------------------------------- STAGE DEPLOY --------------------------------
# ------------------------------------------------------------------------------

FROM ubuntu:24.04  AS stage_deploy

COPY --from=stage_build /emsdk /emsdk

# Fallback in case Emscripten isn't activated.
# This will let use tools offered by this image inside other Docker images
# (sub-stages) or with custom / no entrypoint
ENV EMSDK=/emsdk \
    EMSDK_NODE=/emsdk/node/14.18.2_64bit/bin/node \
    PATH="/emsdk:/emsdk/upstream/emscripten:/emsdk/upstream/bin:/emsdk/node/14.18.2_64bit/bin:${PATH}"

# ------------------------------------------------------------------------------
# Create a 'standard` 1000:1000 user
# Thanks to that this image can be executed as non-root user and created files
# will not require root access level on host machine Please note that this
# solution even if widely spread (i.e. Node.js uses it) is far from perfect as
# user 1000:1000 might not exist on host machine, and in this case running any
# docker image will cause other random problems (mostly due `$HOME` pointing to
# `/`)
RUN echo "## Create emscripten user (1000:1000)" \
    && (groupadd --gid 1000 emscripten 2>/dev/null || true) \
    && (useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home emscripten 2>/dev/null || usermod -d /home/emscripten -s /bin/bash $(getent passwd 1000 | cut -d: -f1)) \
    && echo "umask 0000" >> /etc/bash.bashrc \
    && echo ". /emsdk/emsdk_env.sh" >> /etc/bash.bashrc \
    && echo "## Done"

# ------------------------------------------------------------------------------

RUN echo "## Update and install packages" \
    && apt-get -qq -y update \
    # Somewhere in here apt sets up tzdata which asks for your time zone and blocks
    # waiting for the answer which you can't give as docker build doesn't read from
    # the terninal. The env vars set here avoid the interactive prompt and set the TZ.
    && DEBIAN_FRONTEND="noninteractive" TZ="America/San_Francisco" apt-get -qq install -y --no-install-recommends \
        sudo \
        libxml2 \
        ca-certificates \
        python3 \
        python3-pip \
        python-is-python3 \
        wget \
        curl \
        zip \
        unzip \
        git \
        git-lfs \
        ssh-client \
        build-essential \
        make \
        ant \
        libidn12 \
        cmake \
        openjdk-11-jre-headless \
        autoconf \
        automake \
        pkg-config \
        libtool \
        nodejs \
        npm \
    # Standard Cleanup on Debian images
    && apt-get -y clean \
    && apt-get -y autoclean \
    && apt-get -y autoremove \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/debconf/*-old \
    && rm -rf /usr/share/doc/* \
    && rm -rf /usr/share/man/?? \
    && rm -rf /usr/share/man/??_* \
    && echo "## Done"

# ------------------------------------------------------------------------------
# Use commonly used /src as working directory
WORKDIR /src

# ------------------------------------------------------------------------------
# ----------------------------- STAGE NPM DEPS ---------------------------------
# ------------------------------------------------------------------------------

FROM stage_deploy AS stage_npm_deps

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm ci

# ------------------------------------------------------------------------------
# --------------------------- STAGE FFMPEG SYNC --------------------------------
# ------------------------------------------------------------------------------

FROM stage_npm_deps AS stage_ffmpeg_sync

# Copy Makefile and source needed for syncing
COPY Makefile ./

# Sync FFmpeg and dependencies
RUN npm run sync

# ------------------------------------------------------------------------------
# -------------------------- STAGE FFMPEG BUILD --------------------------------
# ------------------------------------------------------------------------------

FROM stage_ffmpeg_sync AS stage_ffmpeg_build

# Build FFmpeg and its dependencies
RUN npm run build-deps

# ------------------------------------------------------------------------------
# ---------------------------- STAGE WASM BUILD --------------------------------
# ------------------------------------------------------------------------------

FROM stage_ffmpeg_build AS stage_wasm_build

# Copy source files needed for WASM build
COPY src/module ./src/module
COPY src/lib/worker.js ./src/lib/worker.js

# Build WASM module
RUN npm run build-wasm

# ------------------------------------------------------------------------------
# ----------------------------- STAGE JS BUILD ---------------------------------
# ------------------------------------------------------------------------------

FROM stage_wasm_build AS stage_js_build

# Copy remaining source and config files
COPY src/lib ./src/lib
COPY tsconfig.types.json .eslintrc rollup.config.js ./

# Build JavaScript library
RUN npm run build

# ------------------------------------------------------------------------------
# ---------------------------- STAGE ARTIFACTS ---------------------------------
# ------------------------------------------------------------------------------

FROM scratch AS artifacts

# Copy built artifacts from previous stage
# Everything is now in dist/ including decode-audio.wasm
COPY --from=stage_js_build /src/dist ./dist

# ------------------------------------------------------------------------------
# ---------------------------- STAGE DEVELOPMENT -------------------------------
# ------------------------------------------------------------------------------

FROM stage_deploy AS development

# Install Node.js packages globally for development
RUN npm install -g nodemon

# Set user to emscripten for development
USER emscripten

# Default command opens a bash shell
CMD ["/bin/bash"]

# ------------------------------------------------------------------------------
