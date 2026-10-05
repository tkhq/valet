# Document and Slack workflow checks

Run these checks after the fixes are deployed. They do not require the original failed runs.
Each JSON file is a workflow definition. Neither workflow uses an LLM or a schedule.

## Drive Word document

1. Create a Word file containing `VAL_TEST_927: confidentiality lasts 30 days.`
2. Save it as `.docx` without tracked changes. Upload it to Google Drive without conversion to Google Docs.
3. Give the connected Google account access to this test file.
4. Replace `REPLACE_WITH_TEST_DOCX_FILE_ID` in `drive-docx.json` with the file ID from its Drive URL.
5. Select the intended team workspace in Valet. Check that its Google Workspace connection is configured.
6. Open Workflows. Select Import workflow. Paste the edited JSON or choose the file.
7. Name it `Test Drive Word extraction`. Import it, then start one manual run.
8. Open the `read_document` step result. Its `content` must include the complete test sentence.

Expected: the run completes without conversion, an LLM, or a document extraction service.
This proves text extraction. It does not test the NDA review prompt or legal interpretation.
Images are not read. Documents with tracked revisions require accepting or rejecting changes before export.
If credentials or file access fail, resolve that error before judging document extraction.

## Team Slack access

1. Create a public test channel. Invite the connected Valet bot. Post one harmless test message.
2. Copy the channel ID from Slack channel details.
3. Copy your Slack member ID from your profile. Use your own account as the test recipient.
4. Replace both placeholders in `team-slack.json` with those IDs.
5. Select the team workspace in Valet. Import the edited JSON as `Test team Slack access`.
6. Start one manual run. If policy requests approval, review and approve this test action.
7. Check the `read_channel` result. It must contain the public test message.
8. Check your Slack DM from Valet. It must contain the fixed test message once.

Expected: the run completes using the organization bot connection.
An explicit DM recipient does not need a linked Valet account just to receive this message.
Sending a team assistant request remains restricted to linked Valet users with team access.
Private channels and direct-message history do not inherit a workflow creator's personal permissions.
Do not replace the public test channel with a real private conversation.

## Missing account or missing link

1. Use a Slack account without a Valet identity link in a channel with an enabled team-mention subscription.
2. Mention the Valet bot with a harmless request.
3. Expect a private notice explaining account signup, invitations, and linking through Connected accounts.
4. Verify that Valet did not start a team run for this request.
5. Link the account, confirm team membership, and send the request again.

The notice is limited to one attempt per organization, channel, and sender every five minutes.
Slack does not guarantee that an ephemeral notice is displayed. Event receipts record the attempt outcome.
A linked user without team membership remains denied; relinking does not grant membership.

## What to report

Send the workflow run URL, failed step name, and error text if a check fails.
For extraction, report whether the marker sentence appears. Do not include a real contract or credentials.
Delete the two test workflows when finished. They have no recurring triggers.

The automated regression runs these same definitions through workflow creation, execution, and checkpoint storage.
It uses real plugins and DOCX extraction with mocked provider HTTP. It sends no real Slack messages.
