import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import {classifyCopilotIntent} from '@/services/OwnerCopilotService';
assert.deepEqual(classifyCopilotIntent('delete all leads'),{tier:'T5',intent:'delete_blocked'});
assert.deepEqual(classifyCopilotIntent('erase all customer data under GDPR'),{tier:'T5',intent:'erasure_blocked'});
assert.deepEqual(classifyCopilotIntent('send a price list to all leads'),{tier:'T5',intent:'bulk_outreach_blocked'});
console.log('copilot-refusal-reason: 3 passed, 0 failed');
