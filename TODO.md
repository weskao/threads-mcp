# TODO

## Local image upload — remove internet reachability requirement

Currently, `publish_thread_local_image` works by spinning up a temporary local HTTP server
and passing its URL to the Threads API. This means **the machine running the MCP server must
be publicly reachable from the internet** — if it is behind NAT/firewall, the Threads API
cannot fetch the image.

**Goal:** allow local images to be uploaded directly without requiring inbound internet access.

**Possible approaches:**

- Integrate a lightweight tunneling solution (e.g. ngrok SDK, `localtunnel`) so the MCP
  server automatically exposes the local file server via a public URL without manual setup.
- Upload the image to a free/ephemeral hosting service (e.g. Imgur, Cloudinary, S3 presigned
  URL) and pass that URL to the Threads API instead of serving from localhost.
- Use a base64 data URI if/when the Threads API ever supports it.

**Current workaround:** run `ngrok http 3456` before using `publish_thread_local_image`, then
the tunneled URL is used automatically (the local server binds on port 3456 by default).
