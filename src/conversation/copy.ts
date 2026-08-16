/**
 * Every candidate-facing sentence that is not a flow question.
 *
 * The flow questions live in `flow.ts`, next to the answers they accept. This
 * file holds everything else: the welcome, the consent notice, acknowledgements,
 * the completion message, the menus, and the handful of replies the bot gives
 * when a candidate says something the flow did not ask about.
 *
 * Between this file and `flow.ts`, the set of sentences the bot can produce is
 * finite, written by a person, and reviewable in full. That is the mechanism
 * behind "the bot never talks out of context" — not an instruction to a model,
 * which can be disregarded, but the absence of any code path that generates a
 * sentence at runtime.
 *
 * Placeholders are `{{name}}` and are filled by `render()`.
 */

import type { Choice, Localised } from './language.js';

export function render(template: string, vars: Record<string, string | undefined> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Shared answers
 * ───────────────────────────────────────────────────────────────────────────*/

export const YES: Localised = { en: 'Yes', ta: 'ஆம்', hi: 'हाँ' };
export const NO: Localised = { en: 'No', ta: 'இல்லை', hi: 'नहीं' };
export const OTHER: Localised = { en: 'Other', ta: 'வேறு', hi: 'अन्य' };
export const TALK_TO_STAFF: Localised = {
  en: 'Talk to staff',
  ta: 'ஊழியருடன் பேச',
  hi: 'स्टाफ से बात करें',
};

/** Ends a multi-select. Every multi-select list carries this as its last row. */
export const DONE: Localised = {
  en: 'Done — that is all',
  ta: 'முடிந்தது',
  hi: 'हो गया',
};

export const CHOICE_STAFF: Choice = { id: 'staff', label: TALK_TO_STAFF };
export const CHOICE_DONE: Choice = { id: '__done', label: DONE };

/* ─────────────────────────────────────────────────────────────────────────────
 * §2 Start
 * ───────────────────────────────────────────────────────────────────────────*/

export const WELCOME: Localised = {
  en: 'Hi! Welcome to Adira Enterprises 👋\nAre you looking for an overseas job?',
  ta: 'வணக்கம்! அதிரா என்டர்பிரைசஸ்-க்கு வரவேற்கிறோம் 👋\nவெளிநாட்டு வேலை தேடுகிறீர்களா?',
  hi: 'नमस्ते! अदिरा एंटरप्राइजेज में आपका स्वागत है 👋\nक्या आप विदेश में नौकरी ढूंढ रहे हैं?',
};

export const WELCOME_CHOICES: Choice[] = [{ id: 'yes', label: YES }, CHOICE_STAFF];

/** When they answer No to the opening question. Nothing personal has been collected yet. */
export const NOT_LOOKING: Localised = {
  en: 'No problem. Message us any time if you start looking for overseas work.',
  ta: 'பரவாயில்லை. வெளிநாட்டு வேலை தேட விரும்பினால் எப்போது வேண்டுமானாலும் எங்களுக்கு அனுப்புங்கள்.',
  hi: 'कोई बात नहीं। जब भी आप विदेश में काम ढूंढना शुरू करें, हमें मैसेज करें।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §4 Consent
 * ───────────────────────────────────────────────────────────────────────────*/

export const CONSENT_DECLINED: Localised = {
  en: 'No problem. We have not registered your application. You can message us anytime if you wish to continue.',
  ta: 'பரவாயில்லை. உங்கள் விண்ணப்பம் பதிவு செய்யப்படவில்லை. தொடர விரும்பினால் எப்போது வேண்டுமானாலும் எங்களுக்கு அனுப்பலாம்.',
  hi: 'कोई बात नहीं। हमने आपका आवेदन रजिस्टर नहीं किया है। आगे बढ़ना चाहें तो कभी भी मैसेज करें।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §5 CV
 * ───────────────────────────────────────────────────────────────────────────*/

export const CV_RECEIVED: Localised = {
  en: 'CV received ✅ I am checking it now.',
  ta: 'CV கிடைத்தது ✅ இப்போது பார்க்கிறேன்.',
  hi: 'CV मिल गया ✅ मैं इसे देख रहा हूँ।',
};

/** Reply to tapping "Upload CV" — the button cannot open a file picker itself. */
export const GO_AHEAD: Localised = {
  en: 'Go ahead — attach the file here and send it.',
  ta: 'தாராளமாக அனுப்புங்கள் — கோப்பை இங்கே இணைத்து அனுப்பவும்.',
  hi: 'भेजिए — फ़ाइल यहीं अटैच करके भेज दें।',
};

/** Recorded when a candidate says they will send a document later. */
export const WILL_WAIT: Localised = {
  en: 'No problem, send it whenever you can.',
  ta: 'பரவாயில்லை, முடியும்போது அனுப்புங்கள்.',
  hi: 'कोई बात नहीं, जब हो सके तब भेज दीजिए।',
};

export const NO_CV_OK: Localised = {
  en: 'No problem. I will collect a few basic details.',
  ta: 'பரவாயில்லை. சில அடிப்படை விவரங்களைக் கேட்கிறேன்.',
  hi: 'कोई बात नहीं। मैं कुछ बुनियादी जानकारी ले लेता हूँ।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §14–§16 Document acknowledgements
 *
 * Each confirms only that a file arrived and was readable. None of them says
 * verified, approved, or accepted — that is a judgement only staff make (§27).
 * ───────────────────────────────────────────────────────────────────────────*/

export const PASSPORT_RECEIVED: Localised = {
  en: 'Passport received ✅',
  ta: 'பாஸ்போர்ட் கிடைத்தது ✅',
  hi: 'पासपोर्ट मिल गया ✅',
};

export const AADHAAR_RECEIVED: Localised = {
  en: 'Aadhaar received ✅',
  ta: 'ஆதார் கிடைத்தது ✅',
  hi: 'आधार मिल गया ✅',
};

export const PAN_RECEIVED: Localised = {
  en: 'PAN received ✅ Thank you.',
  ta: 'PAN கிடைத்தது ✅ நன்றி.',
  hi: 'PAN मिल गया ✅ धन्यवाद।',
};

export const DOCUMENT_RECEIVED: Localised = {
  en: 'Received ✅',
  ta: 'கிடைத்தது ✅',
  hi: 'मिल गया ✅',
};

/**
 * Sent the moment an identity document arrives.
 *
 * Deliberately does not say "received" — §14 forbids that until the upload has
 * been read and found complete. This says only that we are looking at it, which
 * is true, and the real acknowledgement follows once extraction finishes.
 */
export const CHECKING_DOCUMENT: Localised = {
  en: 'One moment — I am checking the pages.',
  ta: 'ஒரு நிமிடம் — பக்கங்களைப் பார்க்கிறேன்.',
  hi: 'एक मिनट — मैं पेज देख रहा हूँ।',
};

/** Recorded when the candidate says they do not have a document at all. */
export const NOTED: Localised = {
  en: 'Noted, thank you.',
  ta: 'குறித்துக்கொண்டேன், நன்றி.',
  hi: 'नोट कर लिया, धन्यवाद।',
};

/** §14. `{{detail}}` names the pages or the problem. */
export const DOCUMENT_INCOMPLETE: Localised = {
  en: 'Some pages are missing or unclear. Please resend {{detail}}.',
  ta: 'சில பக்கங்கள் இல்லை அல்லது தெளிவாக இல்லை. {{detail}} மீண்டும் அனுப்பவும்.',
  hi: 'कुछ पेज मौजूद नहीं हैं या साफ़ नहीं हैं। कृपया {{detail}} दोबारा भेजें।',
};

export const DOCUMENT_UNREADABLE: Localised = {
  en: 'That file was not clear enough to read. Please send it again in good light, with all four corners visible.',
  ta: 'அந்தக் கோப்பு படிக்கும் அளவுக்குத் தெளிவாக இல்லை. நல்ல வெளிச்சத்தில், நான்கு மூலைகளும் தெரியும்படி மீண்டும் அனுப்பவும்.',
  hi: 'यह फ़ाइल पढ़ने लायक साफ़ नहीं थी। कृपया अच्छी रोशनी में, चारों कोने दिखते हुए दोबारा भेजें।',
};

export const DOCUMENT_ALL_PAGES: Localised = {
  en: 'all pages',
  ta: 'எல்லா பக்கங்களையும்',
  hi: 'सभी पेज',
};

export const DOCUMENT_PAGES: Localised = {
  en: 'page {{pages}}',
  ta: 'பக்கம் {{pages}}',
  hi: 'पेज {{pages}}',
};

export const FILE_FAILED: Localised = {
  en: 'Sorry, that file did not come through. Could you send it once more?',
  ta: 'மன்னிக்கவும், அந்தக் கோப்பு வரவில்லை. மீண்டும் ஒருமுறை அனுப்ப முடியுமா?',
  hi: 'माफ़ कीजिए, वह फ़ाइल नहीं पहुँची। क्या आप इसे एक बार और भेज सकते हैं?',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §17 Identity comparison
 *
 * Deliberately short. §17 forbids running a mismatch investigation over
 * WhatsApp — this hands it to the documentation team and moves on.
 * ───────────────────────────────────────────────────────────────────────────*/

export const IDENTITY_MISMATCH: Localised = {
  en: 'We noticed a difference in some document details. Our documentation team will contact you for verification.',
  ta: 'சில ஆவண விவரங்களில் வேறுபாடு தெரிகிறது. சரிபார்ப்பதற்காக எங்கள் ஆவணக் குழு உங்களைத் தொடர்பு கொள்வார்கள்.',
  hi: 'हमें कुछ दस्तावेज़ों की जानकारी में अंतर मिला है। सत्यापन के लिए हमारी डॉक्यूमेंटेशन टीम आपसे संपर्क करेगी।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §18 Confirmation
 * ───────────────────────────────────────────────────────────────────────────*/

export const CONFIRM_HEADER: Localised = {
  en: 'Please confirm your profile:',
  ta: 'உங்கள் விவரங்களை உறுதிப்படுத்தவும்:',
  hi: 'कृपया अपनी प्रोफ़ाइल कन्फ़र्म करें:',
};

export const CONFIRM_QUESTION: Localised = {
  en: 'Is this correct?',
  ta: 'இது சரியா?',
  hi: 'क्या यह सही है?',
};

export const CONFIRM_LABELS: Record<string, Localised> = {
  name: { en: 'Name', ta: 'பெயர்', hi: 'नाम' },
  skill: { en: 'Current skill', ta: 'தற்போதைய திறமை', hi: 'मौजूदा स्किल' },
  experience: { en: 'Experience', ta: 'அனுபவம்', hi: 'अनुभव' },
  lookingFor: { en: 'Looking for', ta: 'தேடும் வேலை', hi: 'चाहिए' },
  countries: { en: 'Countries', ta: 'நாடுகள்', hi: 'देश' },
  joining: { en: 'Joining', ta: 'சேர முடியும்', hi: 'जॉइनिंग' },
  passport: { en: 'Passport', ta: 'பாஸ்போர்ட்', hi: 'पासपोर्ट' },
  documents: { en: 'Documents', ta: 'ஆவணங்கள்', hi: 'दस्तावेज़' },
};

export const CONFIRM_CHOICES: Choice[] = [
  { id: 'correct', label: { en: 'Yes, correct', ta: 'ஆம், சரி', hi: 'हाँ, सही है' } },
  { id: 'edit', label: { en: 'Edit details', ta: 'திருத்த வேண்டும்', hi: 'बदलाव करें' } },
  CHOICE_STAFF,
];

export const EDIT_PROMPT: Localised = {
  en: 'What would you like to change?',
  ta: 'எதை மாற்ற விரும்புகிறீர்கள்?',
  hi: 'आप क्या बदलना चाहेंगे?',
};

export const EDIT_CHOICES: Choice[] = [
  { id: 'personal', label: { en: 'Personal details', ta: 'தனிப்பட்ட விவரங்கள்', hi: 'निजी जानकारी' } },
  { id: 'experience', label: { en: 'Experience', ta: 'அனுபவம்', hi: 'अनुभव' } },
  { id: 'job_preference', label: { en: 'Job preference', ta: 'வேலை விருப்பம்', hi: 'नौकरी की पसंद' } },
  { id: 'country', label: { en: 'Country preference', ta: 'நாட்டு விருப்பம்', hi: 'देश की पसंद' } },
  { id: 'availability', label: { en: 'Availability', ta: 'சேரும் நேரம்', hi: 'उपलब्धता' } },
  { id: 'documents', label: { en: 'Documents', ta: 'ஆவணங்கள்', hi: 'दस्तावेज़' } },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * §19 Completion
 * ───────────────────────────────────────────────────────────────────────────*/

export const COMPLETED: Localised = {
  en:
    'Registration completed ✅\nCandidate ID: {{candidateId}}\n\n' +
    'We will contact you when a suitable vacancy matches your profile. ' +
    'Registration does not guarantee selection.\n\n' +
    'Reply UPDATE to change your details or DELETE to remove your profile.',
  ta:
    'பதிவு முடிந்தது ✅\nவிண்ணப்ப எண்: {{candidateId}}\n\n' +
    'உங்கள் விவரங்களுக்குப் பொருந்தும் வேலை வரும்போது தொடர்பு கொள்வோம். ' +
    'பதிவு செய்தால் வேலை உறுதி என்று அர்த்தம் இல்லை.\n\n' +
    'விவரங்களை மாற்ற UPDATE என்றும், சுயவிவரத்தை நீக்க DELETE என்றும் அனுப்பவும்.',
  hi:
    'रजिस्ट्रेशन पूरा हुआ ✅\nकैंडिडेट ID: {{candidateId}}\n\n' +
    'आपकी प्रोफ़ाइल से मेल खाती वैकेंसी आने पर हम आपसे संपर्क करेंगे। ' +
    'रजिस्ट्रेशन चयन की गारंटी नहीं है।\n\n' +
    'जानकारी बदलने के लिए UPDATE और प्रोफ़ाइल हटाने के लिए DELETE भेजें।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §20 Returning candidate
 * ───────────────────────────────────────────────────────────────────────────*/

export const RETURNING: Localised = {
  en: 'Welcome back, {{name}}. Your Candidate ID is {{candidateId}}. What would you like to do?',
  ta: 'மீண்டும் வரவேற்கிறோம், {{name}}. உங்கள் விண்ணப்ப எண் {{candidateId}}. என்ன செய்ய விரும்புகிறீர்கள்?',
  hi: 'वापस स्वागत है, {{name}}। आपकी कैंडिडेट ID {{candidateId}} है। आप क्या करना चाहेंगे?',
};

/** Same message for a returning candidate whose registration never completed. */
export const RETURNING_NO_ID: Localised = {
  en: 'Welcome back, {{name}}. What would you like to do?',
  ta: 'மீண்டும் வரவேற்கிறோம், {{name}}. என்ன செய்ய விரும்புகிறீர்கள்?',
  hi: 'वापस स्वागत है, {{name}}। आप क्या करना चाहेंगे?',
};

export const RETURNING_CHOICES: Choice[] = [
  {
    id: 'check_jobs',
    label: { en: 'Check suitable jobs', ta: 'வேலை வாய்ப்புகள்', hi: 'उपयुक्त नौकरियाँ' },
  },
  { id: 'update', label: { en: 'Update profile', ta: 'விவரம் மாற்ற', hi: 'प्रोफ़ाइल अपडेट' } },
  {
    id: 'upload_documents',
    label: { en: 'Upload documents', ta: 'ஆவணம் அனுப்ப', hi: 'दस्तावेज़ भेजें' },
  },
  CHOICE_STAFF,
  { id: 'delete', label: { en: 'Delete profile', ta: 'சுயவிவரம் நீக்க', hi: 'प्रोफ़ाइल हटाएँ' } },
];

/**
 * Answer to "Check suitable jobs".
 *
 * §27 forbids promising a job or telling a candidate they are shortlisted. The
 * bot has no authority to describe anyone's prospects, so this hands over rather
 * than guessing.
 */
export const JOBS_ANSWER: Localised = {
  en: 'Your profile is with our team. When a vacancy matches it, we will message you here. Would you like a staff member to call you about current openings?',
  ta: 'உங்கள் விவரங்கள் எங்கள் குழுவிடம் உள்ளன. பொருந்தும் வேலை வரும்போது இங்கேயே தெரிவிப்போம். தற்போதைய வாய்ப்புகள் குறித்து ஊழியர் ஒருவர் அழைக்க வேண்டுமா?',
  hi: 'आपकी प्रोफ़ाइल हमारी टीम के पास है। मेल खाती वैकेंसी आने पर हम आपको यहीं मैसेज करेंगे। क्या आप चाहेंगे कि कोई स्टाफ मेंबर मौजूदा वैकेंसी के बारे में आपको कॉल करे?',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §21 Reminder
 * ───────────────────────────────────────────────────────────────────────────*/

export const REMINDER: Localised = {
  en: 'Hi {{name}}, your Adira job profile is incomplete. Would you like to continue from where you stopped?',
  ta: 'வணக்கம் {{name}}, உங்கள் அதிரா வேலை விவரங்கள் முழுமையடையவில்லை. நிறுத்திய இடத்திலிருந்து தொடரலாமா?',
  hi: 'नमस्ते {{name}}, आपकी अदिरा जॉब प्रोफ़ाइल अधूरी है। क्या आप वहीं से आगे बढ़ना चाहेंगे जहाँ रुके थे?',
};

export const REMINDER_CHOICES: Choice[] = [
  { id: 'continue', label: { en: 'Continue', ta: 'தொடரவும்', hi: 'आगे बढ़ें' } },
  { id: 'later', label: { en: 'Later', ta: 'பிறகு', hi: 'बाद में' } },
  { id: 'not_interested', label: { en: 'Not interested', ta: 'வேண்டாம்', hi: 'रुचि नहीं' } },
];

export const REMINDER_LATER: Localised = {
  en: 'No problem. Message us whenever you are ready and we will continue from here.',
  ta: 'பரவாயில்லை. நீங்கள் தயாராகும்போது அனுப்புங்கள், இங்கிருந்தே தொடர்வோம்.',
  hi: 'कोई बात नहीं। जब आप तैयार हों तब मैसेज करें, हम यहीं से आगे बढ़ेंगे।',
};

export const REMINDER_NOT_INTERESTED: Localised = {
  en: 'Understood, we will not message you about this again. If you change your mind, just message us here.',
  ta: 'சரி, இது குறித்து மீண்டும் தொந்தரவு செய்ய மாட்டோம். மனம் மாறினால் இங்கே அனுப்புங்கள்.',
  hi: 'ठीक है, हम इस बारे में दोबारा मैसेज नहीं करेंगे। मन बदले तो यहीं मैसेज कर दें।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §22 Update
 * ───────────────────────────────────────────────────────────────────────────*/

export const UPDATE_PROMPT: Localised = {
  en: 'What would you like to update?',
  ta: 'எதைப் புதுப்பிக்க விரும்புகிறீர்கள்?',
  hi: 'आप क्या अपडेट करना चाहेंगे?',
};

export const UPDATE_CHOICES: Choice[] = [
  { id: 'new_experience', label: { en: 'New experience', ta: 'புதிய அனுபவம்', hi: 'नया अनुभव' } },
  { id: 'new_certificate', label: { en: 'New certificate', ta: 'புதிய சான்றிதழ்', hi: 'नया सर्टिफिकेट' } },
  { id: 'job_preference', label: { en: 'Job preference', ta: 'வேலை விருப்பம்', hi: 'नौकरी की पसंद' } },
  { id: 'country', label: { en: 'Country preference', ta: 'நாட்டு விருப்பம்', hi: 'देश की पसंद' } },
  { id: 'documents', label: { en: 'Passport / documents', ta: 'பாஸ்போர்ட்/ஆவணம்', hi: 'पासपोर्ट/दस्तावेज़' } },
  { id: 'availability', label: { en: 'Joining availability', ta: 'சேரும் நேரம்', hi: 'जॉइनिंग उपलब्धता' } },
  { id: 'contact', label: { en: 'Contact details', ta: 'தொடர்பு விவரம்', hi: 'संपर्क जानकारी' } },
];

export const UPDATE_SAVED: Localised = {
  en: 'Updated ✅ Your profile has been changed.',
  ta: 'புதுப்பிக்கப்பட்டது ✅ உங்கள் விவரங்கள் மாற்றப்பட்டன.',
  hi: 'अपडेट हो गया ✅ आपकी प्रोफ़ाइल बदल दी गई है।',
};

export const SEND_CERTIFICATE: Localised = {
  en: 'Please send the certificate as a PDF or a clear photo.',
  ta: 'சான்றிதழை PDF ஆகவோ தெளிவான புகைப்படமாகவோ அனுப்பவும்.',
  hi: 'कृपया सर्टिफिकेट PDF या साफ़ फ़ोटो के रूप में भेजें।',
};

export const SEND_DOCUMENTS: Localised = {
  en: 'Please send the document you would like to add.',
  ta: 'சேர்க்க விரும்பும் ஆவணத்தை அனுப்பவும்.',
  hi: 'जो दस्तावेज़ जोड़ना है वह भेजें।',
};

export const CONTACT_PROMPT: Localised = {
  en: 'Please type the phone number or email you would like us to use.',
  ta: 'நாங்கள் பயன்படுத்த வேண்டிய தொலைபேசி எண் அல்லது மின்னஞ்சலைத் தட்டச்சு செய்யவும்.',
  hi: 'कृपया वह फ़ोन नंबर या ईमेल टाइप करें जो हमें इस्तेमाल करना चाहिए।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §23 Delete
 * ───────────────────────────────────────────────────────────────────────────*/

export const DELETE_CONFIRM: Localised = {
  en: 'Would you like us to delete your candidate profile and stop future job messages?',
  ta: 'உங்கள் சுயவிவரத்தை நீக்கி, இனி வேலை தொடர்பான செய்திகளை நிறுத்த வேண்டுமா?',
  hi: 'क्या आप चाहते हैं कि हम आपकी प्रोफ़ाइल हटा दें और आगे नौकरी के मैसेज बंद कर दें?',
};

export const DELETE_CHOICES: Choice[] = [
  { id: 'delete_yes', label: { en: 'Yes, delete', ta: 'ஆம், நீக்கவும்', hi: 'हाँ, हटाएँ' } },
  { id: 'delete_no', label: { en: 'Cancel', ta: 'வேண்டாம்', hi: 'रहने दें' } },
];

export const DELETED: Localised = {
  en: 'Your profile has been removed and we will not send you job messages. If you want to register again, just message us here.',
  ta: 'உங்கள் சுயவிவரம் நீக்கப்பட்டது; இனி வேலை செய்திகள் அனுப்பப்படாது. மீண்டும் பதிவு செய்ய விரும்பினால் இங்கே அனுப்புங்கள்.',
  hi: 'आपकी प्रोफ़ाइल हटा दी गई है और अब हम नौकरी के मैसेज नहीं भेजेंगे। दोबारा रजिस्टर करना हो तो यहीं मैसेज करें।',
};

export const DELETE_CANCELLED: Localised = {
  en: 'Nothing has been deleted. Your profile is unchanged.',
  ta: 'எதுவும் நீக்கப்படவில்லை. உங்கள் விவரங்கள் அப்படியே உள்ளன.',
  hi: 'कुछ भी नहीं हटाया गया। आपकी प्रोफ़ाइल जैसी थी वैसी ही है।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §24 Staff escalation
 * ───────────────────────────────────────────────────────────────────────────*/

export const STAFF_HANDOFF: Localised = {
  en: 'I am passing you to one of our staff. They will reply here shortly.',
  ta: 'உங்களை எங்கள் ஊழியரிடம் இணைக்கிறேன். விரைவில் இங்கே பதிலளிப்பார்கள்.',
  hi: 'मैं आपको हमारे स्टाफ से जोड़ रहा हूँ। वे जल्द ही यहीं जवाब देंगे।',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Replies to things the flow did not ask about
 *
 * These exist so an off-topic message has a defined, in-scope answer. The bot
 * acknowledges, declines to go further, and re-sends the question it was on.
 * ───────────────────────────────────────────────────────────────────────────*/

/** Salary, visa outcome, selection chances, "which jobs do you have" (§27). */
export const OUT_OF_SCOPE: Localised = {
  en: 'Our staff will answer that when they contact you. Let me finish your registration first.',
  ta: 'அதற்கு எங்கள் ஊழியர் தொடர்பு கொள்ளும்போது பதிலளிப்பார்கள். முதலில் உங்கள் பதிவை முடிக்கிறேன்.',
  hi: 'हमारा स्टाफ संपर्क करने पर इसका जवाब देगा। पहले मैं आपका रजिस्ट्रेशन पूरा कर लेता हूँ।',
};

export const UNCLEAR: Localised = {
  en: 'Sorry, I did not follow that.',
  ta: 'மன்னிக்கவும், அது புரியவில்லை.',
  hi: 'माफ़ कीजिए, मैं समझ नहीं पाया।',
};

/** Asked when a question has been re-asked too often — a person does better. */
export const STUCK: Localised = {
  en: 'Let me pass this to one of our staff so they can help you directly.',
  ta: 'இதை எங்கள் ஊழியரிடம் தருகிறேன், அவர்கள் நேரடியாக உதவுவார்கள்.',
  hi: 'मैं इसे हमारे स्टाफ को दे देता हूँ ताकि वे सीधे आपकी मदद कर सकें।',
};

/**
 * Voice notes (§3).
 *
 * The note is stored against the candidate either way, so staff can listen to
 * it. Until a transcription provider is configured this asks for the answer in a
 * form the flow can record — see `audio.ts`.
 */
export const VOICE_NOT_UNDERSTOOD: Localised = {
  en: 'I have saved your voice message for our staff. Could you also tap an option or type the answer, so I can record it correctly?',
  ta: 'உங்கள் குரல் செய்தியை ஊழியர்களுக்காகச் சேமித்துவிட்டேன். சரியாகப் பதிவு செய்ய, ஒரு விருப்பத்தைத் தேர்ந்தெடுக்கவோ பதிலைத் தட்டச்சு செய்யவோ முடியுமா?',
  hi: 'मैंने आपका वॉइस मैसेज स्टाफ के लिए सेव कर लिया है। सही रिकॉर्ड करने के लिए क्या आप कोई विकल्प चुन सकते हैं या जवाब टाइप कर सकते हैं?',
};

/** Sent when a candidate messages while staff have taken the conversation over (§24). */
export const STAFF_IN_CHARGE: Localised = {
  en: 'One of our staff is looking after this conversation. They will reply here.',
  ta: 'இந்த உரையாடலை எங்கள் ஊழியர் ஒருவர் கவனித்து வருகிறார். அவர்கள் இங்கே பதிலளிப்பார்கள்.',
  hi: 'हमारा एक स्टाफ मेंबर इस बातचीत को देख रहा है। वे यहीं जवाब देंगे।',
};

/** §27 — below the minimum age the flow stops and a person takes over. */
export const AGE_HANDOFF: Localised = {
  en: 'Thank you. One of our staff will contact you about your application.',
  ta: 'நன்றி. உங்கள் விண்ணப்பம் குறித்து எங்கள் ஊழியர் ஒருவர் தொடர்பு கொள்வார்.',
  hi: 'धन्यवाद। आपके आवेदन के बारे में हमारा स्टाफ आपसे संपर्क करेगा।',
};
