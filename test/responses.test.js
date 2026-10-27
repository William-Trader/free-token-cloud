'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  responsesRequestToChat,
  responseFromCompletion,
  streamResponses
} = require('../router');

test('responses request maps instructions, tool calls and tool outputs', () => {
  const chat = responsesRequestToChat({
    model: 'tools',
    instructions: 'you are codex',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' }
    ],
    tools: [
      { type: 'function', name: 'exec', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { type: 'custom', name: 'apply_patch', description: 'patch', format: { type: 'grammar' } }
    ],
    tool_choice: 'auto',
    parallel_tool_calls: true
  });
  assert.equal(chat.model, 'tools');
  assert.equal(chat.stream, false);
  assert.deepEqual(chat.messages[0], { role: 'system', content: 'you are codex' });
  assert.deepEqual(chat.messages[1], { role: 'user', content: 'list files' });
  assert.equal(chat.messages[2].role, 'assistant');
  assert.equal(chat.messages[2].tool_calls[0].id, 'call_1');
  assert.equal(chat.messages[2].tool_calls[0].function.name, 'exec');
  assert.equal(chat.messages[3].role, 'tool');
  assert.equal(chat.messages[3].tool_call_id, 'call_1');
  assert.equal(chat.tools.length, 2);
  assert.equal(chat.tools[0].function.name, 'exec');
  assert.equal(chat.tools[1].function.name, 'apply_patch');
  assert.equal(chat.tools[1].function.parameters.required[0], 'input');
});

test('completion becomes a responses payload with output items and usage', () => {
  const response = responseFromCompletion({
    id: 'chatcmpl-1',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'hello',
        tool_calls: [{
          id: 'call_9',
          type: 'function',
          function: { name: 'exec', arguments: '{"cmd":"pwd"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }, { model: 'tools' });

  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.model, 'tools');
  assert.equal(response.output.length, 2);
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].content[0].text, 'hello');
  assert.equal(response.output[1].type, 'function_call');
  assert.equal(response.output[1].call_id, 'call_9');
  assert.equal(response.output[1].name, 'exec');
  assert.equal(response.usage.input_tokens, 10);
  assert.equal(response.usage.output_tokens, 5);
  assert.equal(response.usage.total_tokens, 15);
  assert.equal(response.output_text, 'hello');
});

test('streaming responses emits the responses event sequence', () => {
  const response = responseFromCompletion({
    choices: [{ index: 0, message: { role: 'assistant', content: 'stream me' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  }, { model: 'tools' });

  const events = [];
  let ended = false;
  const res = {
    writeHead() {},
    write(chunk) {
      const line = chunk.split('\n').find(part => part.startsWith('data: '));
      if (line) events.push(JSON.parse(line.slice(6)));
    },
    end() { ended = true; }
  };
  streamResponses(res, response, {});

  assert.ok(ended);
  assert.equal(events[0].type, 'response.created');
  assert.equal(events[events.length - 1].type, 'response.completed');
  const delta = events.find(event => event.type === 'response.output_text.delta');
  assert.equal(delta.delta, 'stream me');
  assert.equal(events[events.length - 1].response.output_text, 'stream me');
});

test('reasoning is preserved as a reasoning output item', () => {
  const response = responseFromCompletion({
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '答案', reasoning: '先拆问题，再验证假设' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }, { model: 'tools' });
  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(response.output[0].summary[0].text, '先拆问题，再验证假设');
  assert.equal(response.output[1].type, 'message');
});

test('previous reasoning comes back as assistant context', () => {
  const chat = responsesRequestToChat({
    model: 'tools',
    reasoning: { effort: 'high', summary: 'auto' },
    input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '上一轮结论：先建索引' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] }
    ]
  });
  const carried = chat.messages.find(m => m.role === 'assistant' && m.content.includes('先建索引'));
  assert.ok(carried);
  const hint = chat.messages.find(m => m.role === 'system' && m.content.includes('推理预算：high'));
  assert.ok(hint);
});

test('streaming reasoning emits summary events', () => {
  const response = responseFromCompletion({
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok', reasoning: 'think first' }, finish_reason: 'stop' }]
  }, { model: 'tools' });
  const events = [];
  const res = {
    writeHead() {},
    write(chunk) {
      const line = chunk.split('\n').find(part => part.startsWith('data: '));
      if (line) events.push(JSON.parse(line.slice(6)));
    },
    end() {}
  };
  streamResponses(res, response, {});
  assert.ok(events.some(e => e.type === 'response.reasoning_summary_text.delta' && e.delta === 'think first'));
  assert.ok(events.some(e => e.type === 'response.reasoning_summary_part.done'));
});

test('custom tool calls come back as custom_tool_call items', () => {
  const response = responseFromCompletion({
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_patch',
          type: 'function',
          function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  }, { model: 'tools' }, { customTools: ['apply_patch'] });
  assert.equal(response.output[0].type, 'custom_tool_call');
  assert.ok(response.output[0].input.includes('Begin Patch'));
});

test('previous_response_id continues the stored conversation', () => {
  const first = responsesRequestToChat({ model: 'tools', input: '第一步', store: true });
  assert.equal(first.__store, true);
  const response = responseFromCompletion({
    choices: [{ index: 0, message: { role: 'assistant', content: '记住 42' }, finish_reason: 'stop' }]
  }, { model: 'tools' });
  // 直接用导出的 helper 走同一条存储路径
  const { rememberResponse } = require('../router');
  rememberResponse(response.id, first.messages.concat([{ role: 'assistant', content: '记住 42' }]));
  const second = responsesRequestToChat({
    model: 'tools',
    previous_response_id: response.id,
    input: '接着来'
  });
  assert.ok(second.messages.some(m => m.content === '记住 42'));
  assert.ok(second.messages.some(m => m.content === '接着来'));
});

test('structured output and incomplete status are mapped', () => {
  const chat = responsesRequestToChat({
    model: 'tools',
    text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } },
    input: '给 JSON'
  });
  assert.equal(chat.response_format.type, 'json_schema');
  const response = responseFromCompletion({
    choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  }, { model: 'tools' });
  assert.equal(response.status, 'incomplete');
  assert.equal(response.incomplete_details.reason, 'max_output_tokens');
});
