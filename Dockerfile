FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Basic build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    unzip \
    zip \
    wget \
    ca-certificates \
    build-essential \
    python3 \
    openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/*

# Node.js 24 (the current LTS). Expo SDK 58 / React Native 0.88 refuse to
# build on anything older than Node 22.13; Node 20 is also past its end of
# life (April 2026). Older Expo SDKs (54-57) build fine on 24 too.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Android SDK command-line tools
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
       -O /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp/android-tools \
    && mv /tmp/android-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -rf /tmp/cmdline-tools.zip /tmp/android-tools

ENV PATH=${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}

# Accept Android SDK licenses and install the baseline SDK.
RUN yes | sdkmanager --licenses >/dev/null || true \
    && sdkmanager \
       "platform-tools" \
       "platforms;android-36" \
       "build-tools;36.0.0" \
    && chmod -R a+rwX ${ANDROID_HOME}
WORKDIR /build

CMD ["/bin/bash"]
