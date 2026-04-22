FROM ubuntu:22.04 AS setup

ARG IB_GATEWAY_VERSION=10.37.1q
ARG IB_GATEWAY_RELEASE_CHANNEL=stable
ARG IBC_VERSION=3.23.0

RUN apt-get update -y && apt-get install --no-install-recommends --yes \
    ca-certificates \
    curl \
    unzip

WORKDIR /tmp/setup

RUN curl -fsSL https://github.com/UnusualAlpha/ib-gateway-docker/releases/download/ibgateway-${IB_GATEWAY_RELEASE_CHANNEL}%40${IB_GATEWAY_VERSION}/ibgateway-${IB_GATEWAY_VERSION}-standalone-linux-x64.sh \
    -o ibgateway-${IB_GATEWAY_VERSION}-standalone-linux-x64.sh && \
    curl -fsSL https://github.com/UnusualAlpha/ib-gateway-docker/releases/download/ibgateway-${IB_GATEWAY_RELEASE_CHANNEL}%40${IB_GATEWAY_VERSION}/ibgateway-${IB_GATEWAY_VERSION}-standalone-linux-x64.sh.sha256 \
    -o ibgateway-${IB_GATEWAY_VERSION}-standalone-linux-x64.sh.sha256 && \
    sha256sum --check ./ibgateway-${IB_GATEWAY_VERSION}-standalone-linux-x64.sh.sha256 && \
    chmod +x ./ibgateway-${IB_GATEWAY_VERSION}-standalone-linux-x64.sh && \
    ./ibgateway-${IB_GATEWAY_VERSION}-standalone-linux-x64.sh -q -dir /root/Jts/ibgateway/${IB_GATEWAY_VERSION}

RUN curl -fsSL https://github.com/IbcAlpha/IBC/releases/download/${IBC_VERSION}/IBCLinux-${IBC_VERSION}.zip \
    -o IBCLinux-${IBC_VERSION}.zip && \
    mkdir -p /root/ibc && \
    unzip -q ./IBCLinux-${IBC_VERSION}.zip -d /root/ibc && \
    chmod -R u+x /root/ibc/*.sh /root/ibc/scripts/*.sh

FROM ubuntu:22.04

ARG IB_GATEWAY_VERSION=10.37.1q

WORKDIR /root

RUN apt-get update -y && apt-get install --no-install-recommends --yes \
    bash \
    ca-certificates \
    xvfb \
    libxslt-dev \
    libxrender1 \
    libxtst6 \
    libxi6 \
    libgtk2.0-bin \
    procps && \
    mkdir -p /root/Jts /root/ibc /opt/ibkr-live/config

COPY --from=setup /root/ /root/
COPY --from=setup /usr/local/i4j_jres/ /usr/local/i4j_jres/
COPY config/jts.ini /opt/ibkr-live/config/jts.ini
COPY config/config.ini /opt/ibkr-live/config/config.ini
COPY scripts/run.sh /root/scripts/run.sh

RUN chmod +x /root/scripts/run.sh && \
    chmod -R a+rx /root/ibc /root/Jts /usr/local/i4j_jres

ENV TWS_MAJOR_VRSN=${IB_GATEWAY_VERSION}
ENV TWS_PATH=/root/Jts
ENV IBC_PATH=/root/ibc
ENV IBC_INI=/root/ibc/config.ini
ENV TWOFA_TIMEOUT_ACTION=restart
ENV DISPLAY=:1

CMD ["/root/scripts/run.sh"]
