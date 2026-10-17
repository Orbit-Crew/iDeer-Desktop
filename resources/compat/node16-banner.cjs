// Based on linz electron.vite.config.ts at the recorded source commit.
// Executed before main dependencies. Do not inject Node APIs into renderer/preload.
;(function () {
  var streamWeb = require('stream/web')
  var util = require('util')
  if (!globalThis.ReadableStream) globalThis.ReadableStream = streamWeb.ReadableStream
  if (!globalThis.WritableStream) globalThis.WritableStream = streamWeb.WritableStream
  if (!globalThis.TransformStream) globalThis.TransformStream = streamWeb.TransformStream
  if (!globalThis.Blob) globalThis.Blob = require('buffer').Blob
  if (!globalThis.structuredClone) {
    globalThis.structuredClone = function (value) {
      var v8 = require('v8')
      return v8.deserialize(v8.serialize(value))
    }
  }
  if (!globalThis.TextEncoderStream) {
    globalThis.TextEncoderStream = class TextEncoderStream {
      constructor() {
        var encoder = new util.TextEncoder()
        var stream = new streamWeb.TransformStream({
          transform(chunk, controller) { controller.enqueue(encoder.encode(chunk)) }
        })
        this.readable = stream.readable
        this.writable = stream.writable
      }
    }
  }
  if (!globalThis.TextDecoderStream) {
    globalThis.TextDecoderStream = class TextDecoderStream {
      constructor(label, options) {
        var decoder = new util.TextDecoder(label, options)
        var stream = new streamWeb.TransformStream({
          transform(chunk, controller) {
            var text = decoder.decode(chunk, { stream: true })
            if (text) controller.enqueue(text)
          },
          flush(controller) {
            var text = decoder.decode()
            if (text) controller.enqueue(text)
          }
        })
        this.readable = stream.readable
        this.writable = stream.writable
      }
    }
  }
})()
