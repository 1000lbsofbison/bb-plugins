# Listen

Speech in and speech out for BB, running entirely on your own machine with
open models. No cloud service, no API key, no account.

**Speak instead of typing.** BB hands transcription to a plugin, so the
microphone already in the composer becomes the whole interface — press it,
speak, and the words land in the prompt. Nineteen recognition models are
available, from a 43 MB one that runs on a Raspberry Pi to Whisper Large, in
languages from German to Cantonese.

**Have answers read to you.** An LLM answer is not speakable material — code
fences, headings, file paths. So the answer first goes through a hidden thread
that condenses it to two or three plain sentences, and that is what you hear.
Voices come from the Piper, Kitten and Kokoro families.

Everything is set up from the plugin's settings page: install the runtime,
pick a model, install a voice. Nothing to edit by hand except the one
environment variable BB reads its transcription service from, which the page
shows ready to copy.

Ported from pi-listen (MIT) for the Pi coding agent.
