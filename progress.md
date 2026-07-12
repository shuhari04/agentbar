Original prompt: Open-source the entire AgentBar as an independent GitHub repository with bilingual documentation, a deployment example, and a demo video.

## 2026-07-13

- Extracted a fresh AgentBar repository with new Git history and no platform business code.
- Added local guest sessions, PostgreSQL room storage, Docker Compose, migration runner, and open-source documentation.
- Created a 25-second animated WebP preview from the supplied demo recording; the full source video is reserved for the first GitHub Release asset.
- Verified syntax, static serving, guest-cookie issuance, brand/secret scan, and browser UI smoke screenshots for lobby, host controls, card play, dice, and mobile layout.
- Database-backed smoke remains to be run by any deployment with Docker or PostgreSQL; Docker is unavailable on this workstation.
- Published `v1.0.0` and verified the uploaded full demo asset hash against the local source recording.
