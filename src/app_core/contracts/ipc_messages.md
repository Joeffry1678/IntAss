# IntAss IPC Message Contract (Engine → UI)

This document defines the JSON message schema sent from engine.py
to the Electron renderer via main.js.

All messages MUST contain a "type" field.

---

## Status

Sent for general status updates.

Example:
{
  "type": "status",
  "text": "Engine Ready"
}

Fields:
- type: "status"
- text: string

---

## Device List

Sent after "get_devices" command.

Example:
{
  "type": "device_list",
  "devices": [
    { "id": 0, "name": "MIC: Microphone" }
  ]
}

Fields:
- type: "device_list"
- devices: array of { id:number, name:string }

---

## Transcript (Final Speech)

Example:
{
  "type": "transcript",
  "text": "hello world"
}

Fields:
- type: "transcript"
- text: string

---

## Partial (Live Speech)

Example:
{
  "type": "partial",
  "text": "hello"
}

Fields:
- type: "partial"
- text: string

---

## Knowledge Context

Sent before AI result.

Example:
{
  "type": "knowledge_context",
  "text": "Matched document content..."
}

Fields:
- type: "knowledge_context"
- text: string

---

## AI Result

Example:
{
  "type": "ai_result",
  "text": "Final AI answer..."
}

Fields:
- type: "ai_result"
- text: string

---

## AI Error

Example:
{
  "type": "ai_error",
  "message": "AI quota reached"
}

Fields:
- type: "ai_error"
- message: string

---

## Index Done

Example:
{
  "type": "index_done",
  "path": "C:\\resources"
}

Fields:
- type: "index_done"
- path: string

---

## Search Done

Example:
{
  "type": "search_done"
}

Fields:
- type: "search_done"
