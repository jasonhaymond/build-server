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

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
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
