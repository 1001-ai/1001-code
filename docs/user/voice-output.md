# Speech output

An environment can speak with a voice model you download to it. Speech is made
on the environment itself: nothing spoken leaves it. The only network traffic is
the download you start.

## Where voices come from

The voices on offer are your team's list: a `voices/voices.json` file in the
[team catalog](./team-projects.md). Without a team catalog, or without that file,
**Settings → Voice → Speech output** says so and offers nothing. A file that is
not valid is refused as a whole, and the section shows why.

Each model in the list names its license, with a link. Read it before you
download.

## Download a model and choose a voice

1. Open **Settings → Voice** and scroll to **Speech output**.
2. Choose **Download** on a model. The first download on an environment also
   fetches the speech runtime, so it is larger than the model alone.
3. When it is installed, choose **Hear a sample** beside each of its voices.
4. Choose **Use voice** on the one you want.

There is no default voice: nothing speaks until you choose one. The
[voice agent](./team-projects.md#voice-agent) speaks with the voice you choose,
and with your system's voice until then.

A download is installed only after it matches the checksum your team's list
gives for it. If it does not match, nothing is installed and the model shows
**Verification failed**; choose **Download** to try again. You can cancel a
download, and delete an installed model to free its disk space. Deleting the
last model also removes the speech runtime.

Downloading, deleting and choosing a voice need permission to change the
environment's settings. Hearing a sample needs permission to use the
environment.

## Where it runs

Voices are installed per environment. With several environments, the section
lists each one; a voice you download to one is not on the others.

Speech output runs on macOS, on Linux with glibc, and on 64-bit Windows. On
another system the section says that voice models are not available there. The mobile app does not
have this section.
