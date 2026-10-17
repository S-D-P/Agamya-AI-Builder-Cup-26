# Judges' guide

Everything Agamya does, one screen at a time.

**Open** https://agamya-82538920788.us-central1.run.app, then **Sign in → Fill in Work judge** (or Culture judge).

| Space | Email | Password |
|---|---|---|
| Agamya for Work | `judge.work@agamya.example` | `agamya-judges-2026` |
| Agamya for Culture | `judge.culture@agamya.example` | `agamya-judges-2026` |

Use Chrome or Edge on a computer for screen sharing; on a phone, use the camera. Allow the microphone, and wear headphones. The judge spaces are shared, so use test data only.

---

## 1. Two ways in

![Landing](images/01-landing.png)

- **Agamya for Work:** an expert's judgment, captured from their screen.
- **Agamya for Culture:** crafts, dance, recipes and languages, captured on camera.

| Sign-in (judge accounts fill in with one click) | On a phone |
|---|---|
| ![Sign in](images/02-sign-in.png) | ![Mobile](images/01-landing-mobile.png) |

## 2. Home

![Home](images/14-home-sessions.png)

- **Start with your screen** or **camera**.
- **Your recent sessions:** each with a plain status, such as "Building the Work Map" or "Confirmed". You can terminate unfinished ones.
- **Work Maps** you can open.

## 3. Consent, then work

![Consent](images/04-consent.png)

Before anything starts, the card says what is captured, who processes it, who sees it, how long it's kept, and your controls. You also choose the language you'll speak.

## 4. Moti asks why, live (Gemini Live)

![Live capture](images/05-live-capture.png)

- Work as usual and talk if you like.
- Moti stays quiet, then asks **one short question at a pause**, often about a limit or exception. It speaks, and shows the text.
- **Off the record** stops all capture. **Terminate** discards the session.
- **Try:** explain a rule ("anything over 50,000 I hold for the controller"), then pause.

**On camera, in Marathi:**

![Culture, Marathi](images/26-culture-live-marathi.png)

## 5. The Work Map

![Building](images/06-building-map.png)

![Work Map](images/07-work-map.png)

Each step has:
- the **screen moment** (the expert's real screen at that step);
- the **decision**;
- the **reason in the expert's own words** (verified, word for word);
- the **guardrails**: limits, exceptions, *stop and ask a person*, *never*.

Anything the expert didn't say is labelled **AI-inferred**. Moti also lists what it is still unsure about.

![Screen moment](images/08-screen-moment.png)

## 6. Debrief, confirm, share

- **Start the debrief:** Moti asks what is unclear, then explains the process back.
- **Yes, that's how it works:** the expert confirms. Only confirmed maps are used to teach.
- Then: **who should learn from this?**

![Who should learn](images/09-who-should-learn.png)

## 7. Listen in your language (Gemini TTS)

![Listen in Hindi](images/10-listen-hindi.png)

The map becomes a short spoken lesson in any of 15 languages, with a transcript. The expert's own words are kept as they said them.

## 8. AI agents stop where the expert would stop

![Would Asha stop here](images/11-would-asha-stop.png)

- Type an action, for example "Post invoice INV-204 for 72,000 rupees".
- The answer is STOP, ASK, PROCEED or NOT_COVERED, with the expert's words.
- **Connect an agent** gives a key for REST or **MCP**.
- A **Google ADK** agent on **Vertex AI Agent Engine** uses it before every action.

See [AGENTS.md](AGENTS.md).

## 9. Practise with Moti as tutor

| Choose camera or screen, and your language | Moti stops a wrong decision |
|---|---|
| ![Practice](images/12-practice-start.png) | ![Tutor stops](images/13-tutor-stops.png) |

- Do the task. Moti asks you to predict decisions.
- Moti steps in before a guardrail is broken: *"Asha Rao would stop here. Why do you think?"* (shown here in Hindi).
- Press **I'm finished** for a summary of what you handled well and what to practise next.
- On phones, use **Start with my camera**; **Switch camera** flips between front and back.

## 10. Learning, Ask and access

![Learning](images/18-learning.png)

- **Work Maps you can learn from:** Practise, Open and listen.
- **Other Work Maps in this space:** title only, with **Request access**.
- **Ask:** answers only from maps shared with you, quoting the expert.

![Ask](images/19-ask.png)

The expert, or a space admin, grants or declines from the inbox:

![Inbox request](images/20-inbox-request.png)

## 11. Impact, measured

![Impact](images/15-impact.png)

Every number comes from the records, never estimated:
- expert minutes captured and questions asked;
- maps confirmed;
- the share of reasons in the expert's own words;
- mistakes stopped in practice;
- agent checks, languages used and AI cost per map.

## 12. Spaces, people and trust

| Invite (send with your own Gmail) | The join page explains the password |
|---|---|
| ![Invite](images/16-invite-gmail.png) | ![Join](images/17-join-page.png) |

| Optional space passcode | A locked space |
|---|---|
| ![Passcode](images/21-spaces-passcode.png) | ![Locked](images/22-space-locked.png) |

![People](images/23-people.png)

- **Roles:** owner and admin, coordinator, expert or teacher, learner.
- **Admins can:**
  - remove people;
  - see and share every map;
  - plan **KT missions** (below).
- **Separation:** each space keeps its own data and notifications.

![KT mission](images/24-kt-mission.png)

---

**Under the hood:** [Architecture](ARCHITECTURE.md) · [Evaluation](EVALUATION.md) · [Security and privacy](SECURITY.md)
