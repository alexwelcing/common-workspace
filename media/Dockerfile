# Optional batch engine only. The browser app and local worker run independently.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /work
# The worker supplies fixed ffmpeg/ffprobe arguments and runs this container
# without networking, capabilities, root privileges, or a writable root FS.
CMD ["ffmpeg", "-version"]
