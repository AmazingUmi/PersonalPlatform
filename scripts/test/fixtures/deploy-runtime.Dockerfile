FROM docker:29-cli

# Installer prerequisites plus ShellCheck; no host Node, npm, Python or jq.
# Structured validation uses the application image's Node.
RUN apk add --no-cache bash curl openssl coreutils util-linux tar shellcheck \
    && command -v flock && command -v sha256sum

ENTRYPOINT ["bash"]
