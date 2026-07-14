---
type: "note"
title: "Extras round-trip"
description: "Exercises unknown frontmatter keys surviving import/export"
tags: ["fixture"]
confidence: "0.90"
flag: "NO"
valet:
  sensitivity: "shareable"
  origin: "user-stated"
---

# Extras round-trip

This file carries unknown top-level frontmatter keys (`confidence`, `flag`)
that aren't part of the OKF core schema — they must round-trip through
import/export as opaque extras.
