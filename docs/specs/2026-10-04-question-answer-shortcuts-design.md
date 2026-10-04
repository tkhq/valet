# Question answer shortcuts

A focused question answer field submits with Command+Return on macOS or Control+Enter on Windows and Linux. Both invoke the same action as Submit. Plain Enter adds a newline. Empty answers, pending submissions, held keys, and input-method composition do not submit. The Submit button exposes the shortcut in its tooltip and accessibility metadata.

Question option buttons retain their existing direct-submit behavior. Approval and credential gates keep their existing actions.

## Validation

Component tests cover both modifiers, empty answers, composition, held keys, and plain Enter. A browser check confirms Command+Return submits an answer and dismisses the question.
