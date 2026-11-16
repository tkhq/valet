---
name: figma
description: How to look at Figma designs — render frames to images with figma.render_frames and find frame ids with figma.list_frames
---

# Using Figma Tools

- **A URL with `node-id`:** pass it straight to `figma.render_frames`. Do not list frames first.
- **No node given:** call `figma.list_frames`, then render only the frames that matter for the task.
- **Pick a few frames at a time.** `render_frames` takes at most 4 nodes per call. Do not try to render a whole file.
- **Image too large:** each PNG must be under 1 MiB. If a render fails for size, retry that node with a lower `scale` (the error suggests one).
- Frames nested inside sections are not listed. Render the section, or ask the user for a link to the frame.
