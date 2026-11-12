# Model image limits

Status: implemented on branch `xbalbinus/image-attachment-limits`.

A person pasted a 3.8 MB screenshot into a chat. The web composer accepted it, because it checks bytes only: 5 MB for each image, 20 images, 15 MB in total. OpenAI rejected the request:

```
OpenAI API error (400): The image you provided requires 86450 patches after processing, exceeding the limit of 30000
```

Every later message in the thread failed with the same error. A thread keeps the image in `agent.state.messages` and resends it on each turn. Compaction did not help, because compaction never removes the newest user turn. A cold reload rebuilt the same image from the stored entry.

## Limits

`packages/engine/src/image-limits.ts` holds the numbers and their sources.

| Limit | Value | Source |
| --- | --- | --- |
| Long side, model copy | 2000 px | Anthropic rejects a side over 2000 px when a request has more than 20 images. A thread resends every earlier image, so 20 images is a normal count. |
| Total pixels, model copy | 2,560,000 | OpenAI covers an image with 32 px patches. 2.56 MP is 2,500 patches. Anthropic resizes above about 1.15 MP, so more pixels add bytes but no detail. |
| Hard limit, any request | side over 8000 px, or over 30,000 patches of 32 px | Anthropic rejects a side over 8000 px. OpenAI rejects an image over 30,000 patches. |

Sources: [Anthropic vision](https://docs.claude.com/en/docs/build-with-claude/vision), [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision).

## Changes

### Downscale before storage

`Thread.appendUserEntry` calls `fitImageAttachments` before it writes a new user entry. Web, channel, and API messages all pass through this method, so one check covers every entry path. For each PNG, JPEG, GIF, or WebP attachment over a model-copy limit, sharp scales the image to fit both limits and keeps the aspect ratio. JPEG and WebP keep their format at quality 85. PNG and GIF become PNG; a GIF keeps its first frame. EXIF rotation is applied first.

The stored entry holds the small copy. The web chat shows it after a reload, and the model receives it on every turn. Valet does not keep the original.

The header read (`imageDimensions`) skips the decode for an image that already fits. If sharp cannot load or cannot decode the image, the original is stored and the request guard below applies.

### Request guard

`correctImageBlocks` already runs on every provider request (`convertToLlm`). It now reads the size from each image header. An image over a hard limit becomes a text block that names its size and tells the model to ask for a smaller copy. This guard covers images stored before this change and images from other paths, such as tool results. It uses the hard limits, not the model-copy limits, so a 2560 x 1440 tool screenshot still reaches the model.

### Provider rejection

A provider can still reject an image under these limits, for example a model with its own smaller limit. `isImageRejection` matches the image errors from OpenAI, Anthropic, and Gemini. After the transient retry, `Thread.recoverFromImageRejection` runs:

1. It replaces every image block in the failed request with a text note. The error does not say which image failed, so it removes all of them.
2. It writes `imageRejectedByProvider: true` to the metadata of the turn's user entry.
3. It continues the turn once without images, so the person gets an answer to the failed message.

On a cold reload, `entriesToAgentMessages` finds the last marked user entry. It removes images from every message up to the next user entry, which is the same set the failed request carried. Images sent after that turn stay. The stored attachments do not change, so the web chat still shows the image the person sent.

## Limits of this design

- A very tall or very wide image keeps its aspect ratio. A 1000 x 80000 px screenshot becomes 25 x 2000 px, which the model cannot read. Tiling a long image is not in scope.
- The web composer does not warn about pixel size. The server downscales silently.
- A provider rejection removes every earlier image in the thread from model context, not only the bad one.
- Images in tool results are not downscaled. The request guard and the rejection path cover them.
