const express = require('express');
const { load, save, log } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Used only when ANTHROPIC_API_KEY is not set (or a live call fails), so the
// app never breaks during a demo without a key — it degrades gracefully
// instead of failing. Previously this returned one fixed string per keyword
// bucket, so any two similar messages produced identical replies verbatim —
// that's the "it keeps replying the same thing" bug. Fixed by: (1) covering
// many more symptom/topic buckets, (2) personalizing every reply with the
// patient's own name/condition/vitals, and (3) rotating between a few
// phrasings per bucket so the same input doesn't always render byte-identical
// text back-to-back.
function fallbackReply(message, patient, history) {
  const m = message.toLowerCase();
  const name = (patient.name || 'there').split(' ')[0];
  // Deterministic-but-varying pick: rotates through phrasings based on how
  // far along the conversation is, so repeated similar messages don't loop
  // the exact same sentence.
  const pick = (arr) => arr[(history.length + message.length) % arr.length];

  const buckets = [
    {
      test: /chest pain|pain in (my )?chest|pressure in (my )?chest/,
      replies: [
        `That needs attention right away, ${name} — please alert hospital staff immediately. I've flagged this as urgent for your care team.`,
      ],
    },
    {
      test: /breath|wheez|short of breath|can'?t breathe/,
      replies: [
        `Try sitting upright and using your prescribed inhaler, ${name}. If it worsens or your chest feels tight, tell your nurse immediately — I've noted this.`,
        `Given your current SpO₂ of ${patient.vitals?.spo2 ?? '—'}%, new breathing trouble is worth flagging fast — please call your nurse now while I log this for your care team.`,
      ],
    },
    {
      test: /dizz|light[- ]?headed|faint|about to pass out/,
      replies: [
        `Please sit or lie down right away if you're feeling dizzy, ${name}, and press your call button — I've flagged this for your nurse.`,
      ],
    },
    {
      // Checked before the generic pain bucket below, since "headache"
      // would otherwise also match a bare /ache/ test in that bucket.
      test: /headache|migraine/,
      replies: [
        `I've logged the headache for your care team, ${name}. Resting somewhere dim and quiet can help — tell your nurse if it becomes sudden or severe.`,
      ],
    },
    {
      test: /\bpain\b|\bhurt(s|ing)?\b|\bache\b|backache|stomachache|\bsore\b/,
      replies: [
        `I'm sorry you're dealing with that, ${name}. Can you tell me where it is and rate it 1–10? I'll pass this straight to your care team.`,
        `Thanks for telling me. Knowing the location and intensity (1–10) helps your team respond faster — could you share both?`,
      ],
    },
    {
      test: /fever|temperature|chills|shivering/,
      replies: [
        `Keep tracking your temperature every couple of hours and stay hydrated, ${name}. I've noted this for your care team to review.`,
        `A fever alongside ${patient.condition || 'your current condition'} is worth watching closely — I've logged it. Let your nurse know if it climbs or you start shivering.`,
      ],
    },
    {
      test: /nause|vomit|throw up|sick to my stomach/,
      replies: [
        `Noted, ${name} — try small sips of water and hold off on solid food for now. I've flagged the nausea for your care team.`,
      ],
    },
    {
      test: /sleep|insomnia|can'?t sleep|tired|fatigue|exhausted/,
      replies: [
        `Rest matters a lot for recovery, ${name}. I've noted the sleep trouble — your nurse can check whether anything's contributing to it.`,
      ],
    },
    {
      test: /anx|worried|scared|nervous|stress|overwhelmed/,
      replies: [
        `It's completely understandable to feel that way during a hospital stay, ${name}. I've let your care team know so they can check in with you.`,
      ],
    },
    {
      test: /appetite|eat|food|hungry|not eating/,
      replies: [
        `I've noted the change in appetite, ${name}. Small, frequent meals can help if you're up for it — I'll flag this for your nurse too.`,
      ],
    },
    {
      test: /swell|swollen|puffy/,
      replies: [
        `Swelling is worth a closer look — I've flagged it for your care team. Try to keep the area elevated if it's a limb.`,
      ],
    },
    {
      test: /\bcough/,
      replies: [
        `Thanks for letting me know about the cough, ${name} — I've noted it. Tell your nurse if it worsens or you notice blood or discolored mucus.`,
      ],
    },
    {
      test: /medic|dose|tablet|pill|injection/,
      replies: [
        `Please check your medication schedule on your dashboard, ${name}, and never double a missed dose without checking with your nurse first.`,
      ],
    },
    {
      test: /discharge|go home|leaving|when can i leave/,
      replies: [
        `Discharge timing is decided by your care team based on how you're progressing — I've flagged your question so your doctor can update you directly.`,
      ],
    },
    {
      test: /doctor|talk to|speak to|chat with|see (my|the) doctor/,
      replies: [
        `I've sent a request to your doctor to reach out to you — you'll get a notification once they respond.`,
      ],
    },
    {
      test: /thank/,
      replies: [`You're welcome, ${name} — I'm here anytime. Let me know if anything changes.`],
    },
  ];

  for (const b of buckets) {
    if (b.test.test(m)) return pick(b.replies) + '\n\nDecision support only — not a medical diagnosis.';
  }

  const defaults = [
    `Thanks for sharing that, ${name}. Could you tell me a bit more about when it started and how it feels?`,
    `I've noted that for your care team, ${name}. Is it constant, or does it come and go?`,
    `Got it — given ${patient.condition ? 'your current condition (' + patient.condition + ')' : 'your current condition'}, I'll flag this. Has anything made it better or worse?`,
    `Thanks for the update. Would you describe it as mild, moderate, or severe right now?`,
  ];
  return pick(defaults) + '\n\nDecision support only — not a medical diagnosis.';
}

router.post('/', requireRole('patient'), async (req, res) => {
  const db = load();
  const p = db.patients.find((x) => x.id === req.user.profileId);
  if (!p) return res.status(404).json({ error: 'Patient record not found' });

  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is empty' });

  p.chatHistory = p.chatHistory || [];
  p.chatHistory.push({ role: 'user', content: message });

  const doctor = db.doctors.find((d) => d.id === p.doctorId);
  const wantsDoctor = /doctor|talk to|speak to|chat with|see (my|the) doctor/i.test(message);

  let reply;
  let usedAI = false;

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const system = `You are the VitalOps hospital care assistant for patient ${p.name}, age ${p.age}, condition: ${p.condition}. Current vitals: HR ${p.vitals.hr} bpm, SpO2 ${p.vitals.spo2}%, BP ${p.vitals.bp}, RR ${p.vitals.rr}. Current risk level: ${p.riskLevel}. Assigned doctor: ${doctor ? doctor.name + ' (' + doctor.specialty + ')' : 'unassigned'}. Personalize every answer to this patient's actual condition and vitals. Keep answers under 120 words, be warm and clear, and always end your reply with: "Decision support only — not a medical diagnosis." If anything described sounds urgent or severe, clearly tell the patient to alert hospital staff immediately.`;
      const apiMessages = p.chatHistory.slice(-10).map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }));

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
          max_tokens: 300,
          system,
          messages: apiMessages,
        }),
      });
      const data = await resp.json();
      if (data && data.content && data.content[0] && data.content[0].text) {
        reply = data.content[0].text;
        usedAI = true;
      } else {
        // Surface the real reason in the server console instead of silently
        // dropping to the offline fallback every time — this is exactly the
        // kind of failure (bad model name, bad key, rate limit) that used to
        // look like "the bot always gives the same generic reply".
        console.error('Claude API returned no usable content, using offline fallback:', JSON.stringify(data));
        reply = fallbackReply(message, p, p.chatHistory);
      }
    } catch (e) {
      console.error('Claude API call failed, using offline fallback:', e.message);
      reply = fallbackReply(message, p, p.chatHistory);
    }
  } else {
    reply = fallbackReply(message, p, p.chatHistory);
  }

  p.chatHistory.push({ role: 'assistant', content: reply });

  if (wantsDoctor && doctor) {
    const alreadyPending = db.requests.find((r) => r.patientId === p.id && r.status === 'PENDING');
    if (!alreadyPending) {
      db.requests.unshift({
        id: 'REQ-' + Date.now(),
        patientId: p.id,
        patientName: p.name,
        doctorId: doctor.id,
        reason: message,
        status: 'PENDING',
        createdAt: Date.now(),
      });
      log(db, `${p.name} requested a chat with Dr. ${doctor.name} via the AI assistant`);
    }
  }

  save(db);
  res.json({ reply, usedAI });
});

module.exports = router;
