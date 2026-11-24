WorldGen Portable
=================

How to run
----------
1. Unzip the WorldGen-Portable folder anywhere you like.
2. Add an AI key (first time only, see "AI key" below).
3. Double click "Start WorldGen.bat".
4. Your browser opens at http://localhost:3002
5. Keep the black WorldGen window open while you play. Close it when you are finished.

AI key (required)
-----------------
The characters are voiced by an AI language model, so WorldGen needs at least one key.
Double click "Edit Settings.bat" (it creates the settings file the first time), find the
line for your provider, paste your key after the equals sign and save:

  DeepSeek     DEEPSEEK_API_KEY    (low cost, platform.deepseek.com)
  Mistral      MISTRAL_API_KEY     (free tier at console.mistral.ai)
  Gemini       GEMINI_API_KEY      (free tier at aistudio.google.com)
  Cerebras     CEREBRAS_API_KEY
  OpenAI       OPENAI_API_KEY
  Anthropic    ANTHROPIC_API_KEY

Then set LLM_PROVIDER to the matching name: deepseek, mistral, gemini, cerebras, openai or anthropic.
Any OpenAI-compatible server also works: set LLM_PROVIDER to openai and fill in
OPENAI_BASE_URL (its address), OPENAI_API_KEY (its key) and OPENAI_MODEL (a model name).

Demo worlds
-----------
The worlds listed in DEMO-WORLDS.txt are included with all of their pictures and sounds.
Your saved progress goes in the data folder.

Images
------
The included worlds come with every picture they need. New worlds you build can generate
their own pictures if this computer has internet access. To stop all new image generation,
set WORLDGEN_DISABLE_IMAGE_GEN to 1 in the settings.

The world list only shows worlds whose pictures are all present. To see every world, set
WORLDGEN_SHOW_INCOMPLETE_WORLDS to 1, or use the half-circle button at the top of the list.

Moving to another computer
--------------------------
Copy the whole WorldGen-Portable folder (or the zip) and run "Start WorldGen.bat" there.

Port already in use
-------------------
If another program uses port 3002, WorldGen tells you and does not start. Change the PORT
line in the settings to another number such as 3012.

Privacy
-------
Your keys are stored in the .env file in this folder. Do not share the folder or zip
after you have added keys.
