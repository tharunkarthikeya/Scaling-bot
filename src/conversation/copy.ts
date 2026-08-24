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

export const YES: Localised = { en: 'Yes', ta: 'ஆம்', hi: 'हाँ', te: 'అవును', ml: 'അതെ' };
export const NO: Localised = { en: 'No', ta: 'இல்லை', hi: 'नहीं', te: 'కాదు', ml: 'അല്ല' };
export const OTHER: Localised = { en: 'Other', ta: 'வேறு', hi: 'अन्य', te: 'ఇతర', ml: 'മറ്റുള്ളവ' };
export const TALK_TO_STAFF: Localised = {
  en: 'Talk to staff',
  ta: 'ஊழியருடன் பேச',
  hi: 'स्टाफ से बात करें',
  te: 'సిబ్బందితో మాట్లాడు',
  ml: 'സ്റ്റാഫിനെ വിളിക്കുക',
};

/** Ends a multi-select. Every multi-select list carries this as its last row. */
export const DONE: Localised = {
  en: 'Done — that is all',
  ta: 'முடிந்தது',
  hi: 'हो गया',
  te: 'అయిపోయింది — ఇక చాలు',
  ml: 'കഴിഞ്ഞു — ഇത്രയേ ഉള്ളൂ',
};

export const CHOICE_STAFF: Choice = { id: 'staff', label: TALK_TO_STAFF };
export const CHOICE_DONE: Choice = { id: '__done', label: DONE };

/* ─────────────────────────────────────────────────────────────────────────────
 * §2 Start
 * ───────────────────────────────────────────────────────────────────────────*/

export const WELCOME: Localised = {
  en: 'Hi! Welcome to Adira Enterprises 👋\nHow can we help you today?',
  ta: 'வணக்கம்! அதிரா என்டர்பிரைசஸ்-க்கு வரவேற்கிறோம் 👋\nஇன்று நாங்கள் எப்படி உதவலாம்?',
  hi: 'नमस्ते! अदिरा एंटरप्राइजेज में आपका स्वागत है 👋\nहम आपकी क्या मदद कर सकते हैं?',
  te: 'హాయ్! Adira Enterprises కి స్వాగతం 👋\nఈరోజు మీకు ఎలా సాయం చేయగలం?',
  ml: 'ഹായ്! Adira Enterprises ലേക്ക് സ്വാഗതം 👋\nഇന്ന് ഞങ്ങൾക്ക് നിങ്ങളെ എങ്ങനെ സഹായിക്കാം?',
};

/**
 * The three things anyone messaging this number can want (§2).
 *
 * Everything downstream hangs off this one tap. "Apply" opens registration,
 * "Track" reads a decision staff have already recorded, and "Other" opens the
 * short second menu below — the two things that are not a job application.
 */
export const ENTRY_CHOICES: Choice[] = [
  { id: 'other', label: OTHER },
  {
    id: 'track',
    label: { en: 'Track application', ta: 'விண்ணப்ப நிலை', hi: 'आवेदन ट्रैक करें', te: 'దరఖాస్తు ట్రాక్', ml: 'അപേക്ഷ ട്രാക്ക്' },
  },
  {
    id: 'apply',
    label: { en: 'Apply for a job', ta: 'வேலை விண்ணப்பம்', hi: 'नौकरी के लिए आवेदन', te: 'ఉద్యోగానికి దరఖాస్తు', ml: 'ജോലിക്ക് അപേക്ഷ' },
  },
];

/** Kept for the interpreter: someone who types "no" at the opening menu. */
export const NOT_LOOKING: Localised = {
  en: 'No problem. Message us any time if you start looking for overseas work.',
  ta: 'பரவாயில்லை. வெளிநாட்டு வேலை தேட விரும்பினால் எப்போது வேண்டுமானாலும் எங்களுக்கு அனுப்புங்கள்.',
  hi: 'कोई बात नहीं। जब भी आप विदेश में काम ढूंढना शुरू करें, हमें मैसेज करें।',
  te: 'పర్వాలేదు. మీరు విదేశీ పని వెతకడం మొదలుపెడితే ఎప్పుడైనా మాకు మెసేజ్ పెట్టండి.',
  ml: 'കുഴപ്പമില്ല. വിദേശ ജോലി നോക്കി തുടങ്ങുമ്പോൾ എപ്പോൾ വേണമെങ്കിലും ഞങ്ങൾക്ക് മെസ്സേജ് അയക്കൂ.',
};

/**
 * The second menu, behind "Other" (§2).
 *
 * Two things reach it: a business contact, and someone who simply wants a
 * person. Kept off the opening menu because neither is what most people
 * messaging this number are here for, and three buttons is the whole design.
 */
export const OTHER_PROMPT: Localised = {
  en: 'Please choose one of these.',
  ta: 'இவற்றில் ஒன்றைத் தேர்ந்தெடுக்கவும்.',
  hi: 'इनमें से एक चुनें।',
  te: 'వీటిలో ఒకటి ఎంచుకోండి.',
  ml: 'ഇവയിൽ ഒന്ന് തിരഞ്ഞെടുക്കൂ.',
};

export const CHOICE_B2B: Choice = {
  id: 'b2b',
  label: { en: 'B2B enquiry', ta: 'B2B விசாரணை', hi: 'B2B पूछताछ', te: 'B2B విచారణ', ml: 'B2B അന്വേഷണം' },
};

export const OTHER_CHOICES: Choice[] = [CHOICE_B2B, CHOICE_STAFF];

/**
 * B2B (§2).
 *
 * A business contact is not a candidate, so none of the registration flow runs
 * for them: no consent notice, no CV, no trade questions. What is collected is
 * the short list a person needs before ringing back — a name, an Aadhaar, and
 * the company's registration certificate — and then it stops and fetches a
 * person, exactly as it did before there were any questions at all.
 *
 * This line leads into the first of those questions, in the same message.
 */
export const B2B_WELCOME: Localised = {
  en: 'Thank you for your interest in working with Adira Enterprises. I will take a few details and pass them to our business team.',
  ta: 'அதிரா என்டர்பிரைசஸுடன் இணைந்து பணியாற்ற ஆர்வம் காட்டியதற்கு நன்றி. சில விவரங்களைப் பெற்று எங்கள் வணிகக் குழுவிடம் அனுப்புகிறேன்.',
  hi: 'अदिरा एंटरप्राइजेज के साथ काम करने में रुचि दिखाने के लिए धन्यवाद। मैं कुछ जानकारी लेकर हमारी बिज़नेस टीम को भेज दूँगा।',
  te: 'Adira Enterprises తో పని చేయాలనుకున్నందుకు ధన్యవాదాలు. నేను కొన్ని వివరాలు తీసుకుని మా బిజినెస్ టీమ్‌కి పంపిస్తాను.',
  ml: 'Adira Enterprises ഒപ്പം ജോലി ചെയ്യാൻ താൽപ്പര്യം കാണിച്ചതിന് നന്ദി. ഞാൻ കുറച്ച് വിവരങ്ങൾ വാങ്ങി ഞങ്ങളുടെ ബിസിനസ് ടീമിന് കൈമാറാം.',
};

/** The end of the B2B branch: everything is in, and a person takes it from here. */
export const B2B_COMPLETE: Localised = {
  en: 'Thank you — that is everything we need. Our staff will contact you soon.',
  ta: 'நன்றி — எங்களுக்குத் தேவையான அனைத்தும் கிடைத்துவிட்டது. எங்கள் ஊழியர் விரைவில் உங்களைத் தொடர்பு கொள்வார்கள்.',
  hi: 'धन्यवाद — हमें जो चाहिए था वह मिल गया। हमारा स्टाफ जल्द ही आपसे संपर्क करेगा।',
  te: 'ధన్యవాదాలు — మాకు కావలసినవన్నీ వచ్చాయి. మా సిబ్బంది త్వరలో మిమ్మల్ని సంప్రదిస్తారు.',
  ml: 'നന്ദി — ഞങ്ങൾക്ക് വേണ്ടതെല്ലാം കിട്ടി. ഞങ്ങളുടെ സ്റ്റാഫ് ഉടൻ നിങ്ങളെ ബന്ധപ്പെടും.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §4 Consent
 * ───────────────────────────────────────────────────────────────────────────*/

export const CONSENT_DECLINED: Localised = {
  en: 'No problem. We have not registered your application. You can message us anytime if you wish to continue.',
  ta: 'பரவாயில்லை. உங்கள் விண்ணப்பம் பதிவு செய்யப்படவில்லை. தொடர விரும்பினால் எப்போது வேண்டுமானாலும் எங்களுக்கு அனுப்பலாம்.',
  hi: 'कोई बात नहीं। हमने आपका आवेदन रजिस्टर नहीं किया है। आगे बढ़ना चाहें तो कभी भी मैसेज करें।',
  te: 'పర్వాలేదు. మేము మీ అప్లికేషన్‌ని రిజిస్టర్ చేయలేదు. మీరు కొనసాగించాలనుకుంటే ఎప్పుడైనా మెసేజ్ పెట్టవచ్చు.',
  ml: 'കുഴപ്പമില്ല. ഞങ്ങൾ നിങ്ങളുടെ അപേക്ഷ രജിസ്റ്റർ ചെയ്തിട്ടില്ല. തുടരണം എന്ന് തോന്നിയാൽ എപ്പോൾ വേണമെങ്കിലും മെസ്സേജ് അയക്കാം.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §5 CV
 * ───────────────────────────────────────────────────────────────────────────*/

export const CV_RECEIVED: Localised = {
  en: 'CV received ✅ I am checking it now.',
  ta: 'CV கிடைத்தது ✅ இப்போது பார்க்கிறேன்.',
  hi: 'CV मिल गया ✅ मैं इसे देख रहा हूँ।',
  te: 'CV వచ్చింది ✅ ఇప్పుడు చెక్ చేస్తున్నాను.',
  ml: 'CV കിട്ടി ✅ ഇപ്പോൾ ഞാൻ അത് പരിശോധിക്കുന്നു.',
};

/** Reply to tapping "Upload CV" — the button cannot open a file picker itself. */
export const GO_AHEAD: Localised = {
  en: 'Go ahead — attach the file here and send it.',
  ta: 'தாராளமாக அனுப்புங்கள் — கோப்பை இங்கே இணைத்து அனுப்பவும்.',
  hi: 'भेजिए — फ़ाइल यहीं अटैच करके भेज दें।',
  te: 'సరే — ఫైల్‌ని ఇక్కడ జత చేసి పంపండి.',
  ml: 'ശരി — ഫയൽ ഇവിടെ അറ്റാച്ച് ചെയ്ത് അയക്കൂ.',
};

/** Recorded when a candidate says they will send a document later. */
export const WILL_WAIT: Localised = {
  en: 'No problem, send it whenever you can.',
  ta: 'பரவாயில்லை, முடியும்போது அனுப்புங்கள்.',
  hi: 'कोई बात नहीं, जब हो सके तब भेज दीजिए।',
  te: 'పర్వాలేదు, మీకు వీలున్నప్పుడు పంపండి.',
  ml: 'കുഴപ്പമില്ല, കഴിയുമ്പോൾ അയച്ചാൽ മതി.',
};

export const NO_CV_OK: Localised = {
  en: 'No problem. I will collect a few basic details.',
  ta: 'பரவாயில்லை. சில அடிப்படை விவரங்களைக் கேட்கிறேன்.',
  hi: 'कोई बात नहीं। मैं कुछ बुनियादी जानकारी ले लेता हूँ।',
  te: 'పర్వాలేదు. నేను కొన్ని బేసిక్ వివరాలు తీసుకుంటాను.',
  ml: 'സാരമില്ല. ഞാൻ കുറച്ച് അടിസ്ഥാന വിവരങ്ങൾ വാങ്ങാം.',
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
  te: 'పాస్‌పోర్ట్ వచ్చింది ✅',
  ml: 'പാസ്‌പോർട്ട് കിട്ടി ✅',
};

export const AADHAAR_RECEIVED: Localised = {
  en: 'Aadhaar received ✅',
  ta: 'ஆதார் கிடைத்தது ✅',
  hi: 'आधार मिल गया ✅',
  te: 'ఆధార్ వచ్చింది ✅',
  ml: 'ആധാർ കിട്ടി ✅',
};

export const PAN_RECEIVED: Localised = {
  en: 'PAN received ✅ Thank you.',
  ta: 'PAN கிடைத்தது ✅ நன்றி.',
  hi: 'PAN मिल गया ✅ धन्यवाद।',
  te: 'PAN వచ్చింది ✅ థాంక్యూ.',
  ml: 'PAN കിട്ടി ✅ നന്ദി.',
};

/**
 * §12 — what the passport page turned out to say about its own expiry.
 *
 * Sent after the extraction, never before: the bot no longer asks anyone to
 * recall an expiry date, so until the booklet has been read there is nothing
 * honest to say about it.
 *
 * Neither of these refuses anything or asks the candidate to do something they
 * cannot do in this conversation. A passport is renewed at a passport office,
 * not over WhatsApp; the useful thing the bot can do is tell them what it read
 * and let staff take it from there, which is why both end by saying someone will
 * be in touch rather than by demanding a new document.
 */
export const PASSPORT_EXPIRED: Localised = {
  en: 'Thank you. The passport you sent shows an expiry of {{expiry}}, so it has run out. You can still continue here — our team will guide you on renewing it.',
  ta: 'நன்றி. நீங்கள் அனுப்பிய பாஸ்போர்ட்டின் காலாவதி {{expiry}} — அது முடிந்துவிட்டது. இங்கே தொடரலாம்; புதுப்பிப்பது குறித்து எங்கள் குழு வழிகாட்டும்.',
  hi: 'धन्यवाद। आपने जो पासपोर्ट भेजा है उसकी वैधता {{expiry}} तक थी, यानी वह एक्सपायर हो चुका है। आप यहाँ आगे बढ़ सकते हैं — रिन्यूअल के बारे में हमारी टीम आपको बताएगी।',
  te: 'ధన్యవాదాలు. మీరు పంపిన పాస్‌పోర్ట్ గడువు {{expiry}}, అంటే అది అయిపోయింది. మీరు ఇక్కడ కొనసాగవచ్చు — రెన్యువల్ గురించి మా టీమ్ మీకు చెప్తుంది.',
  ml: 'നന്ദി. നിങ്ങൾ അയച്ച പാസ്‌പോർട്ടിന്റെ കാലാവധി {{expiry}} ആണ്, അത് കഴിഞ്ഞു. നിങ്ങൾക്ക് ഇവിടെ തുടരാം — പുതുക്കുന്നതിനെക്കുറിച്ച് ഞങ്ങളുടെ ടീം പറഞ്ഞുതരും.',
};

export const PASSPORT_EXPIRING_SOON: Localised = {
  en: 'Thank you. The passport you sent expires on {{expiry}}, which is quite soon. You can still continue here — our team will let you know if it needs renewing before you travel.',
  ta: 'நன்றி. நீங்கள் அனுப்பிய பாஸ்போர்ட் {{expiry}} அன்று காலாவதியாகிறது — விரைவில். இங்கே தொடரலாம்; பயணத்திற்கு முன் புதுப்பிக்க வேண்டுமா என்பதை எங்கள் குழு தெரிவிக்கும்.',
  hi: 'धन्यवाद। आपने जो पासपोर्ट भेजा है वह {{expiry}} को एक्सपायर हो रहा है, जो काफ़ी नज़दीक है। आप यहाँ आगे बढ़ सकते हैं — यात्रा से पहले रिन्यूअल ज़रूरी है या नहीं, हमारी टीम बता देगी।',
  te: 'ధన్యవాదాలు. మీరు పంపిన పాస్‌పోర్ట్ {{expiry}} న గడువు ముగుస్తుంది, అది చాలా దగ్గరలో ఉంది. మీరు ఇక్కడ కొనసాగవచ్చు — ప్రయాణానికి ముందు రెన్యువల్ కావాలా అనేది మా టీమ్ చెప్తుంది.',
  ml: 'നന്ദി. നിങ്ങൾ അയച്ച പാസ്‌പോർട്ടിന്റെ കാലാവധി {{expiry}} ന് തീരും, അത് വളരെ അടുത്താണ്. നിങ്ങൾക്ക് ഇവിടെ തുടരാം — യാത്രയ്ക്ക് മുൻപ് പുതുക്കേണ്ടതുണ്ടോ എന്ന് ഞങ്ങളുടെ ടീം അറിയിക്കും.',
};

/**
 * Said when the model could not be reached at all.
 *
 * Deliberately not `UNCLEAR`. That line tells the candidate their message could
 * not be used as an answer, which in this case is a lie: the message was fine
 * and never got read. Blaming a candidate for our own capacity is the kind of
 * small dishonesty that teaches people the bot does not work.
 *
 * It asks for the same message again rather than offering staff, because the
 * next attempt will almost always succeed — and it is never counted towards the
 * handoff, so a run of these cannot quietly push someone out of the flow.
 */
export const BUSY_TRY_AGAIN: Localised = {
  en: 'Sorry — I am very busy at the moment and did not catch that. Could you send it once more?',
  ta: 'மன்னிக்கவும் — இப்போது கொஞ்சம் அதிக வேலை, அதைப் புரிந்துகொள்ள முடியவில்லை. மீண்டும் ஒருமுறை அனுப்ப முடியுமா?',
  hi: 'माफ़ कीजिए — अभी थोड़ा व्यस्त हूँ और वह समझ नहीं पाया। क्या आप इसे एक बार फिर भेज सकते हैं?',
  te: 'క్షమించండి — ఇప్పుడు కొంచెం బిజీగా ఉన్నాను, అది అందుకోలేకపోయాను. మరొక్కసారి పంపగలరా?',
  ml: 'ക്ഷമിക്കണം — ഇപ്പോൾ അൽപ്പം തിരക്കിലാണ്, അത് കിട്ടിയില്ല. ഒന്നുകൂടി അയക്കാമോ?',
};

export const DOCUMENT_RECEIVED: Localised = {
  en: 'Received ✅',
  ta: 'கிடைத்தது ✅',
  hi: 'मिल गया ✅',
  te: 'వచ్చింది ✅',
  ml: 'കിട്ടി ✅',
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
  te: 'ఒక్క నిమిషం — పేజీలు చూస్తున్నాను.',
  ml: 'ഒരു നിമിഷം — ഞാൻ പേജുകൾ നോക്കുകയാണ്.',
};

/** Recorded when the candidate says they do not have a document at all. */
export const NOTED: Localised = {
  en: 'Noted, thank you.',
  ta: 'குறித்துக்கொண்டேன், நன்றி.',
  hi: 'नोट कर लिया, धन्यवाद।',
  te: 'సరే, థాంక్యూ.',
  ml: 'മനസ്സിലായി, നന്ദി.',
};

/** §14. `{{detail}}` names the pages or the problem. */
export const DOCUMENT_INCOMPLETE: Localised = {
  en: 'Some pages are missing or unclear. Please resend {{detail}}.',
  ta: 'சில பக்கங்கள் இல்லை அல்லது தெளிவாக இல்லை. {{detail}} மீண்டும் அனுப்பவும்.',
  hi: 'कुछ पेज मौजूद नहीं हैं या साफ़ नहीं हैं। कृपया {{detail}} दोबारा भेजें।',
  te: 'కొన్ని పేజీలు మిస్ అయ్యాయి లేదా క్లియర్‌గా లేవు. దయచేసి {{detail}} మళ్ళీ పంపండి.',
  ml: 'കുറച്ച് പേജുകൾ ഇല്ല അല്ലെങ്കിൽ വ്യക്തമല്ല. ദയവായി {{detail}} വീണ്ടും അയക്കൂ.',
};

export const DOCUMENT_UNREADABLE: Localised = {
  en: 'That file was not clear enough to read. Please send it again in good light, with all four corners visible.',
  ta: 'அந்தக் கோப்பு படிக்கும் அளவுக்குத் தெளிவாக இல்லை. நல்ல வெளிச்சத்தில், நான்கு மூலைகளும் தெரியும்படி மீண்டும் அனுப்பவும்.',
  hi: 'यह फ़ाइल पढ़ने लायक साफ़ नहीं थी। कृपया अच्छी रोशनी में, चारों कोने दिखते हुए दोबारा भेजें।',
  te: 'ఆ ఫైల్ చదవడానికి సరిగ్గా క్లియర్‌గా లేదు. దయచేసి మంచి లైట్‌లో, నాలుగు మూలలు కనిపించేలా మళ్ళీ పంపండి.',
  ml: 'ആ ഫയൽ വ്യക്തമായി വായിക്കാൻ പറ്റുന്നില്ല. നല്ല വെളിച്ചത്തിൽ, നാല് മൂലയും കാണുന്ന വിധം വീണ്ടും അയക്കൂ.',
};

/**
 * Nothing at all came back from the extractor (§14).
 *
 * At this point a bad photo and a file that is not the document are
 * indistinguishable, so the wording covers both without accusing anyone of
 * sending the wrong thing. `{{document}}` names the slot — "passport",
 * "Aadhaar card" — so the candidate knows exactly what to point the camera at.
 */
export const DOCUMENT_NOT_READ: Localised = {
  en: 'I could not read anything from that file. Please send a clear photo of your {{document}} — the whole page, flat, in good light, with all four corners visible.',
  ta: 'அந்தக் கோப்பிலிருந்து எதையும் என்னால் படிக்க முடியவில்லை. உங்கள் {{document}}-ஐ தெளிவாகப் படம் எடுத்து அனுப்பவும் — முழுப் பக்கமும், நல்ல வெளிச்சத்தில், நான்கு மூலைகளும் தெரியும்படி.',
  hi: 'मैं उस फ़ाइल से कुछ भी नहीं पढ़ पाया। कृपया अपने {{document}} की साफ़ फ़ोटो भेजें — पूरा पेज, अच्छी रोशनी में, चारों कोने दिखते हुए।',
  te: 'ఆ ఫైల్ లో నాకు ఏమీ చదవడానికి కుదరలేదు. దయచేసి మీ {{document}} యొక్క క్లియర్ ఫోటో పంపండి — పూర్తి పేజీ, నిటారుగా, మంచి లైట్‌లో, నాలుగు మూలలు కనిపించేలా.',
  ml: 'ആ ഫയലിൽ നിന്ന് ഒന്നും വായിക്കാൻ പറ്റിയില്ല. നിങ്ങളുടെ {{document}}ന്റെ വ്യക്തമായ ഫോട്ടോ അയക്കൂ — മുഴുവൻ പേജും, നിവർത്തി, നല്ല വെളിച്ചത്തിൽ, നാല് മൂലയും കാണുന്ന വിധം.',
};

/**
 * The upload read cleanly and is a different document (§14).
 *
 * Only sent when the extraction was confident enough to trust — see
 * `identifyDocument` in the OCR client. Saying "that isn't your PAN" about a
 * blurred PAN would be both wrong and insulting, so the bar is deliberately high.
 */
export const DOCUMENT_WRONG_TYPE: Localised = {
  en: 'That does not look like a {{document}}. Could you check the file and send your {{document}}?',
  ta: 'அது {{document}} போல் தெரியவில்லை. கோப்பைச் சரிபார்த்து உங்கள் {{document}}-ஐ அனுப்ப முடியுமா?',
  hi: 'यह {{document}} जैसा नहीं लग रहा। कृपया फ़ाइल जाँच कर अपना {{document}} भेजें।',
  te: 'ఇది {{document}} లా అనిపించలేదు. ఫైల్ చెక్ చేసి మీ {{document}} పంపగలరా?',
  ml: 'ഇത് {{document}} ആണെന്ന് തോന്നുന്നില്ല. ഫയൽ ഒന്ന് നോക്കി നിങ്ങളുടെ {{document}} അയക്കാമോ?',
};

/** Stands in for the document's name when the slot has no label of its own. */
export const DOCUMENT_THIS_ONE: Localised = {
  en: 'document',
  ta: 'ஆவணம்',
  hi: 'दस्तावेज़',
  te: 'డాక్యుమెంట్',
  ml: 'ഡോക്യുമെന്റ്',
};

export const DOCUMENT_ALL_PAGES: Localised = {
  en: 'all pages',
  ta: 'எல்லா பக்கங்களையும்',
  hi: 'सभी पेज',
  te: 'అన్ని పేజీలు',
  ml: 'എല്ലാ പേജും',
};

export const DOCUMENT_PAGES: Localised = {
  en: 'page {{pages}}',
  ta: 'பக்கம் {{pages}}',
  hi: 'पेज {{pages}}',
  te: 'పేజీ {{pages}}',
  ml: 'പേജ് {{pages}}',
};

export const FILE_FAILED: Localised = {
  en: 'Sorry, that file did not come through. Could you send it once more?',
  ta: 'மன்னிக்கவும், அந்தக் கோப்பு வரவில்லை. மீண்டும் ஒருமுறை அனுப்ப முடியுமா?',
  hi: 'माफ़ कीजिए, वह फ़ाइल नहीं पहुँची। क्या आप इसे एक बार और भेज सकते हैं?',
  te: 'సారీ, ఆ ఫైల్ రాలేదు. దయచేసి మళ్ళీ ఒకసారి పంపగలరా?',
  ml: 'ക്ഷമിക്കണം, ആ ഫയൽ കിട്ടിയില്ല. ഒന്നുകൂടി അയക്കാമോ?',
};

/**
 * Said when a file is refused on its size, and never confused with FILE_FAILED.
 *
 * The two are different problems and want opposite advice. "Send it once more"
 * is right for a download that dropped and useless for a file that is simply
 * too big — resending it produces the identical refusal, and the candidate is
 * left doing it again with no idea why. So this says what is wrong, gives the
 * number, and names the two things that actually shrink a document: photograph
 * the pages instead of scanning them, or send them a few at a time.
 *
 * `{{limit}}` is filled with the limit in whole megabytes.
 */
export const FILE_TOO_LARGE: Localised = {
  en: 'That file is too large — we can accept up to {{limit}} MB. Please send a smaller version: photos of each page usually work well, or send the pages a few at a time.',
  ta: 'அந்தக் கோப்பு மிகப் பெரியது — {{limit}} MB வரை மட்டுமே ஏற்க முடியும். சிறிய அளவில் அனுப்பவும்: ஒவ்வொரு பக்கத்தையும் புகைப்படமாக எடுத்து அனுப்பலாம், அல்லது பக்கங்களைச் சில சிலவாக அனுப்பலாம்.',
  hi: 'वह फ़ाइल बहुत बड़ी है — हम {{limit}} MB तक ही ले सकते हैं। कृपया छोटी फ़ाइल भेजें: हर पेज की फ़ोटो आमतौर पर ठीक रहती है, या पेज थोड़े-थोड़े करके भेजें।',
  te: 'ఆ ఫైల్ చాలా పెద్దది — మేము {{limit}} MB వరకు మాత్రమే తీసుకోగలం. దయచేసి చిన్న ఫైల్ పంపండి: ప్రతి పేజీ ఫోటో సాధారణంగా సరిపోతుంది, లేదా పేజీలను కొన్ని కొన్నిగా పంపండి.',
  ml: 'ആ ഫയൽ വളരെ വലുതാണ് — {{limit}} MB വരെ മാത്രമേ സ്വീകരിക്കാൻ കഴിയൂ. ദയവായി ചെറിയ ഫയൽ അയക്കുക: ഓരോ പേജിന്റെയും ഫോട്ടോ സാധാരണയായി മതിയാകും, അല്ലെങ്കിൽ പേജുകൾ കുറച്ചു വീതം അയക്കുക.',
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
  te: 'కొన్ని డాక్యుమెంట్ వివరాల్లో తేడా గమనించాం. వెరిఫికేషన్ కోసం మా డాక్యుమెంటేషన్ టీమ్ మిమ్మల్ని సంప్రదిస్తుంది.',
  ml: 'ചില ഡോക്യുമെന്റ് വിവരങ്ങളിൽ ഒരു വ്യത്യാസം ഞങ്ങൾ ശ്രദ്ധിച്ചു. ഞങ്ങളുടെ ഡോക്യുമെന്റേഷൻ ടീം ഉറപ്പുവരുത്താൻ നിങ്ങളെ ബന്ധപ്പെടും.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §18 Confirmation
 * ───────────────────────────────────────────────────────────────────────────*/

export const CONFIRM_HEADER: Localised = {
  en: 'Please confirm your profile:',
  ta: 'உங்கள் விவரங்களை உறுதிப்படுத்தவும்:',
  hi: 'कृपया अपनी प्रोफ़ाइल कन्फ़र्म करें:',
  te: 'మీ ప్రొఫైల్‌ని ఒకసారి కన్ఫర్మ్ చేయండి:',
  ml: 'നിങ്ങളുടെ പ്രൊഫൈൽ ശരിയാണോ എന്ന് പറയൂ:',
};

export const CONFIRM_QUESTION: Localised = {
  en: 'Is this correct?',
  ta: 'இது சரியா?',
  hi: 'क्या यह सही है?',
  te: 'ఇది కరెక్టేనా?',
  ml: 'ഇത് ശരിയാണോ?',
};

export const CONFIRM_LABELS: Record<string, Localised> = {
  name: { en: 'Name', ta: 'பெயர்', hi: 'नाम', te: 'పేరు', ml: 'പേര്' },
  skill: { en: 'Current skill', ta: 'தற்போதைய திறமை', hi: 'मौजूदा स्किल', te: 'ప్రస్తుత స్కిల్', ml: 'ഇപ്പോഴത്തെ സ്കിൽ' },
  experience: { en: 'Experience', ta: 'அனுபவம்', hi: 'अनुभव', te: 'అనుభవం', ml: 'പരിചയം' },
  lookingFor: { en: 'Looking for', ta: 'தேடும் வேலை', hi: 'चाहिए', te: 'కావాల్సింది', ml: 'ആവശ്യമുള്ളത്' },
  countries: { en: 'Countries', ta: 'நாடுகள்', hi: 'देश', te: 'దేశాలు', ml: 'രാജ്യങ്ങൾ' },
  joining: { en: 'Joining', ta: 'சேர முடியும்', hi: 'जॉइनिंग', te: 'చేరిక', ml: 'ജോയിനിംഗ്' },
  passport: { en: 'Passport', ta: 'பாஸ்போர்ட்', hi: 'पासपोर्ट', te: 'పాస్‌పోర్ట్', ml: 'പാസ്‌പോർട്ട്' },
  documents: { en: 'Documents', ta: 'ஆவணங்கள்', hi: 'दस्तावेज़', te: 'డాక్యుమెంట్లు', ml: 'ഡോക്യുമെന്റുകൾ' },
};

// No staff row. A person is reached from one place only - "Other" on the
// opening menu - and offering it here as well put the button at the end of a
// registration somebody had just finished answering.
export const CONFIRM_CHOICES: Choice[] = [
  { id: 'correct', label: { en: 'Yes, correct', ta: 'ஆம், சரி', hi: 'हाँ, सही है', te: 'అవును, సరైనది', ml: 'അതെ, ശരിയാണ്' } },
  { id: 'edit', label: { en: 'Edit details', ta: 'திருத்த வேண்டும்', hi: 'बदलाव करें', te: 'వివరాలు మార్చండి', ml: 'വിവരം തിരുത്തുക' } },
];

export const EDIT_PROMPT: Localised = {
  en: 'What would you like to change?',
  ta: 'எதை மாற்ற விரும்புகிறீர்கள்?',
  hi: 'आप क्या बदलना चाहेंगे?',
  te: 'మీరు ఏం మార్చాలనుకుంటున్నారు?',
  ml: 'എന്താണ് മാറ്റേണ്ടത്?',
};

export const EDIT_CHOICES: Choice[] = [
  { id: 'personal', label: { en: 'Personal details', ta: 'தனிப்பட்ட விவரங்கள்', hi: 'निजी जानकारी', te: 'వ్యక్తిగత వివరాలు', ml: 'സ്വന്തം വിവരങ്ങൾ' } },
  { id: 'experience', label: { en: 'Experience', ta: 'அனுபவம்', hi: 'अनुभव', te: 'అనుభవం', ml: 'പരിചയം' } },
  { id: 'job_preference', label: { en: 'Job preference', ta: 'வேலை விருப்பம்', hi: 'नौकरी की पसंद', te: 'పని ఇష్టం', ml: 'ജോലി താൽപ്പര്യം' } },
  { id: 'country', label: { en: 'Country preference', ta: 'நாட்டு விருப்பம்', hi: 'देश की पसंद', te: 'దేశం ఇష్టం', ml: 'രാജ്യം താൽപ്പര്യം' } },
  { id: 'availability', label: { en: 'Availability', ta: 'சேரும் நேரம்', hi: 'उपलब्धता', te: 'అందుబాటు', ml: 'ലഭ്യത' } },
  { id: 'documents', label: { en: 'Documents', ta: 'ஆவணங்கள்', hi: 'दस्तावेज़', te: 'డాక్యుమెంట్లు', ml: 'ഡോക്യുമെന്റുകൾ' } },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * §19 Completion
 * ───────────────────────────────────────────────────────────────────────────*/

export const COMPLETED: Localised = {
  en:
    'Registration completed ✅\nApplication ID: {{candidateId}}\n\n' +
    'Thank you for registering with Adira Enterprises. Please keep this ID — ' +
    'send it to us any time to check your application status.\n\n' +
    'We will contact you when a suitable vacancy matches your profile. ' +
    'Registration does not guarantee selection.\n\n' +
    'Reply UPDATE to change your details or DELETE to remove your profile.',
  ta:
    'பதிவு முடிந்தது ✅\nவிண்ணப்ப எண்: {{candidateId}}\n\n' +
    'அதிரா என்டர்பிரைசஸில் பதிவு செய்ததற்கு நன்றி. இந்த எண்ணை வைத்திருங்கள் — ' +
    'உங்கள் விண்ணப்ப நிலையை அறிய எப்போது வேண்டுமானாலும் இதை அனுப்பலாம்.\n\n' +
    'உங்கள் விவரங்களுக்குப் பொருந்தும் வேலை வரும்போது தொடர்பு கொள்வோம். ' +
    'பதிவு செய்தால் வேலை உறுதி என்று அர்த்தம் இல்லை.\n\n' +
    'விவரங்களை மாற்ற UPDATE என்றும், சுயவிவரத்தை நீக்க DELETE என்றும் அனுப்பவும்.',
  hi:
    'रजिस्ट्रेशन पूरा हुआ ✅\nएप्लिकेशन ID: {{candidateId}}\n\n' +
    'अदिरा एंटरप्राइजेज में रजिस्टर करने के लिए धन्यवाद। यह ID संभालकर रखें — ' +
    'अपने आवेदन की स्थिति जानने के लिए इसे कभी भी हमें भेज सकते हैं।\n\n' +
    'आपकी प्रोफ़ाइल से मेल खाती वैकेंसी आने पर हम आपसे संपर्क करेंगे। ' +
    'रजिस्ट्रेशन चयन की गारंटी नहीं है।\n\n' +
    'जानकारी बदलने के लिए UPDATE और प्रोफ़ाइल हटाने के लिए DELETE भेजें।',
    te: 'నమోదు పూర్తయ్యింది ✅\nApplication ID: {{candidateId}}\n\nAdira Enterprises లో నమోదు చేసుకున్నందుకు ధన్యవాదాలు. ఈ ID ను దాచుకోండి — మీ దరఖాస్తు స్థితి తెలుసుకోవాలంటే ఎప్పుడైనా మాకు పంపండి.\n\nమీ ప్రొఫైల్‌కు తగిన ఖాళీ ఉన్నప్పుడు మేము మిమ్మల్ని సంప్రదిస్తాము. నమోదు చేసుకున్నంత మాత్రాన ఎంపిక ఖాయం కాదు.\n\nమీ వివరాలు మార్చాలంటే UPDATE అని, మీ ప్రొఫైల్ తీసేయాలంటే DELETE అని రిప్లై ఇవ్వండి.',
    ml: 'രജിസ്ട്രേഷൻ പൂർത്തിയായി ✅\nഅപേക്ഷ ഐഡി: {{candidateId}}\n\nAdira Enterprises ൽ രജിസ്റ്റർ ചെയ്തതിന് നന്ദി. ഈ ഐഡി സൂക്ഷിച്ചു വെക്കണേ — എപ്പോൾ വേണമെങ്കിലും ഇത് അയച്ചാൽ അപേക്ഷയുടെ സ്ഥിതി അറിയാൻ പറ്റും.\n\nനിങ്ങളുടെ പ്രൊഫൈലിന് ചേരുന്ന ഒഴിവ് വന്നാൽ ഞങ്ങൾ ബന്ധപ്പെടും. രജിസ്ട്രേഷൻ ചെയ്തതുകൊണ്ട് സെലക്ഷൻ ഉറപ്പല്ല.\n\nവിവരങ്ങൾ മാറ്റാൻ UPDATE എന്നും പ്രൊഫൈൽ നീക്കം ചെയ്യാൻ DELETE എന്നും റിപ്ലൈ ചെയ്യൂ.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Application tracking
 *
 * Reports a decision staff have already recorded, and nothing else. The bot has
 * no view on anyone's prospects and §27 forbids it inventing one — so there are
 * exactly three things it can say, one per stored status, plus "I could not find
 * that".
 * ───────────────────────────────────────────────────────────────────────────*/

export const TRACK_ASK_ID: Localised = {
  en: 'Please type your Application ID.\nExample: ADR-00042',
  ta: 'உங்கள் விண்ணப்ப எண்ணைத் தட்டச்சு செய்யவும்.\nஎடுத்துக்காட்டு: ADR-00042',
  hi: 'कृपया अपनी एप्लिकेशन ID टाइप करें।\nउदाहरण: ADR-00042',
  te: 'దయచేసి మీ Application ID టైప్ చేయండి.\nఉదాహరణ: ADR-00042',
  ml: 'നിങ്ങളുടെ അപേക്ഷ ഐഡി ടൈപ്പ് ചെയ്യൂ.\nഉദാഹരണം: ADR-00042',
};

export const TRACK_PENDING: Localised = {
  en: 'Application ID: {{candidateId}}\nStatus: In progress ⏳\n\nYour profile is with our team. We will message you here as soon as there is an update.',
  ta: 'விண்ணப்ப எண்: {{candidateId}}\nநிலை: பரிசீலனையில் ⏳\n\nஉங்கள் விவரங்கள் எங்கள் குழுவிடம் உள்ளன. புதிய தகவல் வந்தவுடன் இங்கேயே தெரிவிப்போம்.',
  hi: 'एप्लिकेशन ID: {{candidateId}}\nस्थिति: प्रक्रिया में ⏳\n\nआपकी प्रोफ़ाइल हमारी टीम के पास है। कोई अपडेट आते ही हम आपको यहीं मैसेज करेंगे।',
  te: 'Application ID: {{candidateId}}\nస్థితి: జరుగుతోంది ⏳\n\nమీ ప్రొఫైల్ మా టీమ్ దగ్గర ఉంది. ఏదైనా అప్‌డేట్ రాగానే మేము ఇక్కడ మీకు మెసేజ్ చేస్తాము.',
  ml: 'അപേക്ഷ ഐഡി: {{candidateId}}\nസ്ഥിതി: നടന്നു കൊണ്ടിരിക്കുന്നു ⏳\n\nനിങ്ങളുടെ പ്രൊഫൈൽ ഞങ്ങളുടെ ടീമിന്റെ കയ്യിലുണ്ട്. പുതിയ വിവരം വന്നാൽ ഉടനെ ഇവിടെ അറിയിക്കാം.',
};

export const TRACK_COMPLETED: Localised = {
  en: 'Application ID: {{candidateId}}\nStatus: Completed ✅\n\nOur staff will contact you about the next steps.',
  ta: 'விண்ணப்ப எண்: {{candidateId}}\nநிலை: முடிந்தது ✅\n\nஅடுத்த கட்டங்கள் குறித்து எங்கள் ஊழியர் தொடர்பு கொள்வார்கள்.',
  hi: 'एप्लिकेशन ID: {{candidateId}}\nस्थिति: पूरा हुआ ✅\n\nअगले चरणों के बारे में हमारा स्टाफ आपसे संपर्क करेगा।',
  te: 'Application ID: {{candidateId}}\nస్థితి: పూర్తయింది ✅\n\nతర్వాతి స్టెప్స్ గురించి మా సిబ్బంది మిమ్మల్ని సంప్రదిస్తారు.',
  ml: 'അപേക്ഷ ഐഡി: {{candidateId}}\nസ്ഥിതി: പൂർത്തിയായി ✅\n\nഅടുത്ത കാര്യങ്ങളെ കുറിച്ച് ഞങ്ങളുടെ സ്റ്റാഫ് നിങ്ങളെ ബന്ധപ്പെടും.',
};

/**
 * Plain, and not unkind. A candidate is told the outcome once and told their
 * profile stays on file, because it does — §23 deletion is the only thing that
 * removes it, and that is their decision, not ours.
 */
export const TRACK_REJECTED: Localised = {
  en: 'Application ID: {{candidateId}}\nStatus: Not proceeding\n\nWe are not able to take this application forward. Your profile stays with us for future vacancies, and we will be in touch if something suitable comes up.',
  ta: 'விண்ணப்ப எண்: {{candidateId}}\nநிலை: தொடரவில்லை\n\nஇந்த விண்ணப்பத்தை எங்களால் தொடர முடியவில்லை. உங்கள் விவரங்கள் எதிர்கால வாய்ப்புகளுக்காக எங்களிடம் இருக்கும்; பொருத்தமானது வந்தால் தொடர்பு கொள்வோம்.',
  hi: 'एप्लिकेशन ID: {{candidateId}}\nस्थिति: आगे नहीं बढ़ रहे\n\nहम इस आवेदन को आगे नहीं बढ़ा पा रहे हैं। आपकी प्रोफ़ाइल भविष्य की वैकेंसी के लिए हमारे पास रहेगी, और कुछ उपयुक्त आने पर हम संपर्क करेंगे।',
  te: 'Application ID: {{candidateId}}\nస్థితి: ముందుకు వెళ్లడం లేదు\n\nఈ దరఖాస్తును మేము ముందుకు తీసుకెళ్లలేకపోతున్నాము. మీ ప్రొఫైల్ భవిష్యత్ ఖాళీల కోసం మా దగ్గరే ఉంటుంది, ఏదైనా సరిపోయేది వచ్చినప్పుడు మేము మిమ్మల్ని సంప్రదిస్తాము.',
  ml: 'അപേക്ഷ ഐഡി: {{candidateId}}\nസ്ഥിതി: മുന്നോട്ട് പോകുന്നില്ല\n\nഈ അപേക്ഷ മുന്നോട്ട് കൊണ്ടുപോകാൻ ഞങ്ങൾക്ക് പറ്റുന്നില്ല. നിങ്ങളുടെ പ്രൊഫൈൽ വരും കാലത്തെ ഒഴിവുകൾക്കായി ഞങ്ങളുടെ കയ്യിൽ ഉണ്ടാകും, പറ്റിയത് വന്നാൽ ഞങ്ങൾ ബന്ധപ്പെടും.',
};

/**
 * No application with that id belongs to this number.
 *
 * Deliberately does not distinguish "no such id" from "that id is someone
 * else's" — an application id is short and guessable, and confirming that one
 * exists would leak another candidate's record to anyone who typed it.
 *
 * Sent on either of the first two attempts, with no option attached and none
 * needed: the id question stays open, so the next thing they type is read as
 * another id. It used to offer a staff button; a person is now reached from the
 * opening menu alone, and the third miss offers the lookup below instead.
 */
export const TRACK_NOT_FOUND: Localised = {
  en: 'I could not find an application with that ID for this number. Please check the ID and send it again.',
  ta: 'இந்த எண்ணுக்கு அந்த விண்ணப்ப எண்ணில் எதுவும் கிடைக்கவில்லை. எண்ணைச் சரிபார்த்து மீண்டும் அனுப்பவும்.',
  hi: 'इस नंबर के लिए उस ID से कोई आवेदन नहीं मिला। कृपया ID जाँचकर दोबारा भेजें।',
  te: 'ఈ నంబర్‌కు ఆ ID తో ఏ దరఖాస్తూ కనబడలేదు. దయచేసి ID చెక్ చేసి మళ్ళీ పంపండి.',
  ml: 'ഈ നമ്പറിന് ആ ഐഡിയിൽ ഒരു അപേക്ഷയും കണ്ടെത്താനായില്ല. ഐഡി ഒന്ന് പരിശോധിച്ച് വീണ്ടും അയക്കൂ.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §25  "I have lost my Application ID"
 *
 * Offered on the third miss, not the first. Two attempts is enough for a typo
 * or a transposed digit, and putting a lookup in front of somebody who is
 * simply mistyping teaches them to use the slower path.
 *
 * The lookup itself is the tracking check with its two halves swapped: instead
 * of an id confirmed by a date of birth, it is a mobile number and a date of
 * birth that between them name the id. It is scoped to the number that sent it,
 * exactly as `lookUpApplication` is, and it costs attempts the same way — an id
 * is worth only as much as the check standing in front of it.
 * ───────────────────────────────────────────────────────────────────────────*/

/** Offered as a row once two ids have missed. Inside the 20-glyph title limit. */
export const CHOICE_FORGOT_ID: Choice = {
  id: 'forgot_id',
  label: { en: 'Forgot my ID', ta: 'ID மறந்தேன்', hi: 'ID याद नहीं', te: 'ID గుర్తు లేదు', ml: 'ID ഓർമ്മയില്ല' },
};

export const TRACK_NOT_FOUND_FORGOT: Localised = {
  en: 'I still could not find that ID for this number. If you do not have it, tap below and I will look it up from your mobile number and date of birth.',
  ta: 'இந்த எண்ணுக்கு அந்த விண்ணப்ப எண் இன்னும் கிடைக்கவில்லை. உங்களிடம் அது இல்லையென்றால் கீழே தட்டவும் — உங்கள் மொபைல் எண் மற்றும் பிறந்த தேதி மூலம் நான் தேடிச் சொல்கிறேன்.',
  hi: 'इस नंबर के लिए वह ID अब भी नहीं मिली। अगर आपके पास नहीं है, तो नीचे टैप करें — मैं आपके मोबाइल नंबर और जन्म तिथि से ढूँढ दूँगा।',
  te: 'ఈ నంబర్‌కు ఆ ID ఇప్పటికీ కనబడలేదు. మీ దగ్గర లేకపోతే కింద నొక్కండి — మీ మొబైల్ నంబర్, పుట్టిన తేదీతో నేను వెతికి చెప్తాను.',
  ml: 'ഈ നമ്പറിന് ആ ഐഡി ഇപ്പോഴും കണ്ടെത്താനായില്ല. നിങ്ങളുടെ കയ്യിൽ ഇല്ലെങ്കിൽ താഴെ ടാപ്പ് ചെയ്യൂ — മൊബൈൽ നമ്പറും ജനന തീയതിയും വെച്ച് ഞാൻ കണ്ടുപിടിക്കാം.',
};

export const TRACK_FORGOT_ASK_MOBILE: Localised = {
  en: 'No problem. Please send the mobile number on your application.\nExample: 9876543210',
  ta: 'பரவாயில்லை. உங்கள் விண்ணப்பத்தில் உள்ள மொபைல் எண்ணை அனுப்பவும்.\nஎடுத்துக்காட்டு: 9876543210',
  hi: 'कोई बात नहीं। कृपया अपने आवेदन में दिया मोबाइल नंबर भेजें।\nउदाहरण: 9876543210',
  te: 'ఫర్వాలేదు. మీ దరఖాస్తులో ఇచ్చిన మొబైల్ నంబర్ పంపండి.\nఉదాహరణ: 9876543210',
  ml: 'കുഴപ്പമില്ല. നിങ്ങളുടെ അപേക്ഷയിൽ കൊടുത്ത മൊബൈൽ നമ്പർ അയക്കൂ.\nഉദാഹരണം: 9876543210',
};

export const TRACK_FORGOT_ASK_DOB: Localised = {
  en: 'And the date of birth on it.\nExample: 25/05/1994',
  ta: 'அதில் உள்ள பிறந்த தேதியையும் அனுப்பவும்.\nஎடுத்துக்காட்டு: 25/05/1994',
  hi: 'और उसमें दी गई जन्म तिथि भेजिए।\nउदाहरण: 25/05/1994',
  te: 'అందులో ఉన్న పుట్టిన తేదీ కూడా పంపండి.\nఉదాహరణ: 25/05/1994',
  ml: 'അതിലെ ജനന തീയതിയും അയക്കൂ.\nഉദാഹരണം: 25/05/1994',
};

export const TRACK_FORGOT_FOUND: Localised = {
  en: 'Found it. Your Application ID is {{candidateId}}.\nPlease keep it safe — you will need it to check your application.',
  ta: 'கிடைத்துவிட்டது. உங்கள் விண்ணப்ப எண்: {{candidateId}}.\nஇதைப் பத்திரமாக வைத்திருங்கள் — விண்ணப்ப நிலையைப் பார்க்க இது தேவை.',
  hi: 'मिल गया। आपकी एप्लिकेशन ID है {{candidateId}}।\nइसे सँभालकर रखें — आवेदन की स्थिति देखने के लिए यही चाहिए।',
  te: 'దొరికింది. మీ Application ID: {{candidateId}}.\nదీన్ని జాగ్రత్తగా ఉంచుకోండి — దరఖాస్తు స్థితి చూడటానికి ఇదే కావాలి.',
  ml: 'കിട്ടി. നിങ്ങളുടെ അപേക്ഷ ഐഡി {{candidateId}} ആണ്.\nഇത് സൂക്ഷിച്ചു വെക്കൂ — അപേക്ഷയുടെ സ്ഥിതി അറിയാൻ ഇത് വേണം.',
};

export const TRACK_FORGOT_NO_MATCH: Localised = {
  en: 'Those details do not match an application on this number. Please try once more — {{remaining}} left.',
  ta: 'இந்த எண்ணில் உள்ள எந்த விண்ணப்பத்துடனும் இந்த விவரங்கள் பொருந்தவில்லை. மீண்டும் முயற்சிக்கவும் — இன்னும் {{remaining}} வாய்ப்பு.',
  hi: 'ये जानकारी इस नंबर के किसी आवेदन से मेल नहीं खाती। कृपया एक बार और कोशिश करें — {{remaining}} मौके बाकी।',
  te: 'ఈ నంబర్‌లోని ఏ దరఖాస్తుతోనూ ఈ వివరాలు సరిపోలడం లేదు. మరోసారి ప్రయత్నించండి — ఇంకా {{remaining}} అవకాశాలు.',
  ml: 'ഈ നമ്പറിലെ ഒരു അപേക്ഷയുമായും ഈ വിവരങ്ങൾ ചേരുന്നില്ല. ഒന്നു കൂടി ശ്രമിക്കൂ — ഇനി {{remaining}} തവണ.',
};
/* ─────────────────────────────────────────────────────────────────────────────
 * The identity check in front of a status (§25, §27)
 *
 * An Application ID is short, sequential, and read out over the phone. Knowing
 * one is not evidence of being the person it belongs to — and an application
 * status, together with the fact that a record exists at all, is something §27
 * says we owe to the candidate and to nobody else. So the id names the
 * application, and the date of birth on it confirms who is asking.
 *
 * Deliberately a low wall, not a high one. The lookup is already restricted to
 * the number that registered, so this guards against someone else holding the
 * same handset rather than against a stranger — common enough on a shared phone
 * to be worth a question, not serious enough to be worth an ordeal.
 * ───────────────────────────────────────────────────────────────────────────*/

export const TRACK_ASK_DOB: Localised = {
  en: 'Just to confirm it is you — please send the date of birth on this application.\nExample: 25/05/1994',
  ta: 'இது நீங்கள்தான் என்பதை உறுதிப்படுத்த — இந்த விண்ணப்பத்தில் உள்ள பிறந்த தேதியை அனுப்பவும்.\nஎடுத்துக்காட்டு: 25/05/1994',
  hi: 'बस पुष्टि के लिए — इस आवेदन में दी गई जन्म तिथि भेजिए।\nउदाहरण: 25/05/1994',
  te: 'ఇది మీరేనని నిర్ధారించుకోవడానికి — ఈ దరఖాస్తులో ఉన్న పుట్టిన తేదీ పంపండి.\nఉదాహరణ: 25/05/1994',
  ml: 'നിങ്ങൾ തന്നെയാണെന്ന് ഉറപ്പിക്കാൻ — ഈ അപേക്ഷയിലെ ജനന തീയതി അയക്കൂ.\nഉദാഹരണം: 25/05/1994',
};

/**
 * A date we could not read at all.
 *
 * Not counted as a wrong answer, and that is why it has a message of its own:
 * "1994" or "May" is someone who has not understood the format, and spending
 * one of their three chances on a misunderstanding would be unfair. Only a date
 * we could read, and that did not match, costs an attempt.
 */
export const TRACK_DOB_UNREADABLE: Localised = {
  en: 'I could not read that as a date. Please send it as day/month/year.\nExample: 25/05/1994',
  ta: 'அதைத் தேதியாகப் படிக்க முடியவில்லை. நாள்/மாதம்/ஆண்டு என அனுப்பவும்.\nஎடுத்துக்காட்டு: 25/05/1994',
  hi: 'मैं उसे तारीख के रूप में नहीं पढ़ पाया। कृपया दिन/महीना/साल के रूप में भेजें।\nउदाहरण: 25/05/1994',
  te: 'దాన్ని తేదీగా చదవలేకపోయాను. దయచేసి రోజు/నెల/సంవత్సరం లా పంపండి.\nఉదాహరణ: 25/05/1994',
  ml: 'അത് ഒരു തീയതിയായി വായിക്കാൻ പറ്റിയില്ല. ദിവസം/മാസം/വർഷം എന്ന രീതിയിൽ അയക്കൂ.\nഉദാഹരണം: 25/05/1994',
};

/**
 * Wrong, with the chances remaining.
 *
 * Saying how many are left is a usability call, not a leak: the lookup is
 * already restricted to the number that registered, so the person reading this
 * is almost always the candidate mistyping their own date of birth, and leaving
 * them to guess how much rope they have is needless anxiety.
 */
export const TRACK_DOB_WRONG: Localised = {
  en: 'That does not match the date of birth on this application. Please try once more — {{remaining}} left.',
  ta: 'இந்த விண்ணப்பத்தில் உள்ள பிறந்த தேதியுடன் இது பொருந்தவில்லை. மீண்டும் முயற்சிக்கவும் — இன்னும் {{remaining}} வாய்ப்பு.',
  hi: 'यह इस आवेदन की जन्म तिथि से मेल नहीं खाती। कृपया एक बार और कोशिश करें — {{remaining}} मौके बाकी।',
  te: 'ఇది ఈ దరఖాస్తులోని పుట్టిన తేదీతో సరిపోలడం లేదు. మరోసారి ప్రయత్నించండి — ఇంకా {{remaining}} అవకాశాలు.',
  ml: 'ഇത് ഈ അപേക്ഷയിലെ ജനന തീയതിയുമായി ചേരുന്നില്ല. ഒന്നു കൂടി ശ്രമിക്കൂ — ഇനി {{remaining}} തവണ.',
};

/**
 * Out of chances.
 *
 * The status is not shown and no hint is given about what the right answer was.
 * A person takes it from here — which is also the honest outcome for a
 * candidate who genuinely cannot remember what was written on their own
 * application.
 */
export const TRACK_DOB_EXHAUSTED: Localised = {
  en: 'I cannot confirm this application over chat. Please contact our staff and they will check it for you.',
  ta: 'இந்த விண்ணப்பத்தை இங்கு உறுதிப்படுத்த முடியவில்லை. எங்கள் ஊழியரைத் தொடர்பு கொள்ளுங்கள், அவர்கள் பார்த்துச் சொல்வார்கள்.',
  hi: 'मैं इस आवेदन की पुष्टि चैट पर नहीं कर सकता। कृपया हमारे स्टाफ से संपर्क करें, वे आपके लिए देख लेंगे।',
  te: 'ఈ దరఖాస్తును చాట్‌లో నిర్ధారించలేను. దయచేసి మా సిబ్బందిని సంప్రదించండి, వాళ్ళు చూసి చెప్తారు.',
  ml: 'ഈ അപേക്ഷ ചാറ്റിൽ ഉറപ്പിക്കാൻ എനിക്ക് പറ്റില്ല. ഞങ്ങളുടെ സ്റ്റാഫിനെ ബന്ധപ്പെടൂ, അവർ നോക്കി പറയും.',
};

/**
 * The application has no date of birth recorded, so there is nothing to check
 * against.
 *
 * Handed to a person rather than waved through. A check that cannot be
 * performed is not a check that passed, and §27 makes no exception for records
 * that happen to be thin.
 */
export const TRACK_CANNOT_VERIFY: Localised = {
  en: 'I need to check a detail before I can show this application, and it is not on file. Please contact our staff and they will help.',
  ta: 'இந்த விண்ணப்பத்தைக் காட்டும் முன் ஒரு விவரத்தைச் சரிபார்க்க வேண்டும், அது பதிவில் இல்லை. எங்கள் ஊழியரைத் தொடர்பு கொள்ளுங்கள்.',
  hi: 'यह आवेदन दिखाने से पहले मुझे एक जानकारी जाँचनी है, जो रिकॉर्ड में नहीं है। कृपया हमारे स्टाफ से संपर्क करें।',
  te: 'ఈ దరఖాస్తు చూపించే ముందు ఒక వివరం చెక్ చేయాలి, అది రికార్డులో లేదు. దయచేసి మా సిబ్బందిని సంప్రదించండి.',
  ml: 'ഈ അപേക്ഷ കാണിക്കും മുൻപ് ഒരു വിവരം പരിശോധിക്കണം, അത് രേഖയിൽ ഇല്ല. ഞങ്ങളുടെ സ്റ്റാഫിനെ ബന്ധപ്പെടൂ.',
};

/** They asked to track before finishing registration — there is no id yet. */
export const TRACK_NOT_REGISTERED: Localised = {
  en: 'You do not have an Application ID yet — your registration is not finished. Shall we continue from where you stopped?',
  ta: 'உங்களுக்கு இன்னும் விண்ணப்ப எண் இல்லை — பதிவு முடியவில்லை. நிறுத்திய இடத்திலிருந்து தொடரலாமா?',
  hi: 'आपके पास अभी एप्लिकेशन ID नहीं है — आपका रजिस्ट्रेशन पूरा नहीं हुआ है। क्या हम वहीं से आगे बढ़ें जहाँ रुके थे?',
  te: 'మీకు ఇంకా Application ID రాలేదు — మీ నమోదు పూర్తి కాలేదు. మీరు ఆగిన చోటు నుండి కొనసాగిద్దామా?',
  ml: 'നിങ്ങൾക്ക് ഇതുവരെ അപേക്ഷ ഐഡി ഇല്ല — രജിസ്ട്രേഷൻ പൂർത്തിയായിട്ടില്ല. നിർത്തിയിടത്ത് നിന്ന് തുടരണോ?',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Idle sessions
 *
 * A session left open for `TUNABLES.sessionTimeoutMinutes` is closed and the
 * candidate is told so, with the two ways out. Nothing is discarded — every
 * answer is written as it arrives — so closing a session costs the candidate
 * nothing but a tap.
 *
 * Two wordings, one choice. `SESSION_ENDED` is pushed the moment the session
 * lapses; `RESUME_PROMPT` greets someone whose next message arrives before the
 * sweep reached them, which still happens after a restart or an outage. Both
 * offer `RESUME_CHOICES`, so the reply is handled identically either way.
 * ───────────────────────────────────────────────────────────────────────────*/

export const SESSION_ENDED: Localised = {
  en:
    'Your session has been terminated due to inactivity.\n' +
    'Your answers are saved — would you like to continue, or start again?',
  ta:
    'செயல்பாடு இல்லாததால் உங்கள் அமர்வு நிறுத்தப்பட்டது.\n' +
    'உங்கள் பதில்கள் சேமிக்கப்பட்டுள்ளன — தொடரலாமா, அல்லது முதலிலிருந்து தொடங்கலாமா?',
  hi:
    'निष्क्रियता के कारण आपका सेशन समाप्त कर दिया गया है।\n' +
    'आपके जवाब सुरक्षित हैं — क्या आप आगे बढ़ना चाहेंगे, या शुरू से शुरू करना चाहेंगे?',
    te: 'చాలా సేపు ఏమీ చేయకపోవడం వల్ల మీ సెషన్ ఆగిపోయింది.\nమీ జవాబులు సేవ్ అయ్యాయి — కొనసాగించాలా, లేదా మళ్లీ మొదటి నుండి మొదలుపెట్టాలా?',
    ml: 'കുറേ നേരം ഒന്നും ചെയ്യാത്തതു കൊണ്ട് നിങ്ങളുടെ സെഷൻ അവസാനിപ്പിച്ചു.\nനിങ്ങളുടെ ഉത്തരങ്ങൾ സേവ് ചെയ്തിട്ടുണ്ട് — തുടരണോ, അതോ വീണ്ടും തുടങ്ങണോ?',
};

export const RESUME_PROMPT: Localised = {
  en: 'Welcome back{{name}}. Your registration is saved and not finished. Would you like to continue from where you stopped?',
  ta: 'மீண்டும் வரவேற்கிறோம்{{name}}. உங்கள் பதிவு சேமிக்கப்பட்டுள்ளது, முடியவில்லை. நிறுத்திய இடத்திலிருந்து தொடரலாமா?',
  hi: 'वापस स्वागत है{{name}}। आपका रजिस्ट्रेशन सेव है और अधूरा है। क्या आप वहीं से आगे बढ़ना चाहेंगे जहाँ रुके थे?',
  te: 'తిరిగి స్వాగతం{{name}}. మీ నమోదు సేవ్ అయి ఉంది, పూర్తి కాలేదు. మీరు ఆగిన చోటు నుండి కొనసాగించాలనుకుంటున్నారా?',
  ml: 'തിരിച്ചു വന്നതിൽ സന്തോഷം{{name}}. നിങ്ങളുടെ രജിസ്ട്രേഷൻ സേവ് ചെയ്തിട്ടുണ്ട്, പൂർത്തിയായിട്ടില്ല. നിർത്തിയിടത്ത് നിന്ന് തുടരണോ?',
};

export const RESUME_CHOICES: Choice[] = [
  { id: 'continue', label: { en: 'Continue session', ta: 'தொடரவும்', hi: 'आगे बढ़ें', te: 'సెషన్ కొనసాగించు', ml: 'സെഷൻ തുടരുക' } },
  { id: 'restart', label: { en: 'Restart session', ta: 'முதலிலிருந்து', hi: 'शुरू से', te: 'సెషన్ మళ్లీ మొదలు', ml: 'സെഷൻ പുനരാരംഭിക്കുക' } },
];

/**
 * Says what a restart actually does now.
 *
 * It used to be four words, and it used to be true: restarting emptied the
 * profile. It no longer does — nothing is deleted — so the sentence has to carry
 * the part the candidate cares about, which is that they are not about to be
 * asked everything a second time.
 */
export const RESTARTED: Localised = {
  en: 'Starting again from the beginning. Your saved answers and documents are kept, so I will only ask for anything still missing.',
  ta: 'முதலிலிருந்து மீண்டும் தொடங்குகிறோம். நீங்கள் அளித்த பதில்களும் ஆவணங்களும் அப்படியே இருக்கும் — மீதமுள்ளதை மட்டும் கேட்பேன்.',
  hi: 'शुरुआत से फिर से शुरू कर रहे हैं। आपके सेव किए गए जवाब और दस्तावेज़ वैसे ही रहेंगे — जो बाकी है सिर्फ़ वही पूछूँगा।',
  te: 'మొదటి నుండి మళ్లీ మొదలుపెడుతున్నాము. మీరు ఇచ్చిన జవాబులు, డాక్యుమెంట్లు అలాగే ఉంటాయి — మిగిలినవి మాత్రమే అడుగుతాను.',
  ml: 'തുടക്കം മുതൽ വീണ്ടും തുടങ്ങുന്നു. നിങ്ങൾ തന്ന ഉത്തരങ്ങളും രേഖകളും അതുപോലെ ഉണ്ടാകും — ബാക്കിയുള്ളത് മാത്രമേ ചോദിക്കൂ.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §20 Returning candidate
 * ───────────────────────────────────────────────────────────────────────────*/

export const RETURNING: Localised = {
  en: 'Welcome back, {{name}}. Your Application ID is {{candidateId}}. What would you like to do?',
  ta: 'மீண்டும் வரவேற்கிறோம், {{name}}. உங்கள் விண்ணப்ப எண் {{candidateId}}. என்ன செய்ய விரும்புகிறீர்கள்?',
  hi: 'वापस स्वागत है, {{name}}। आपकी एप्लिकेशन ID {{candidateId}} है। आप क्या करना चाहेंगे?',
  te: 'మళ్ళీ వచ్చినందుకు స్వాగతం, {{name}}. మీ దరఖాస్తు ఐడి {{candidateId}}. మీరు ఏం చేయాలనుకుంటున్నారు?',
  ml: 'തിരികെ വന്നതിൽ സന്തോഷം, {{name}}. നിങ്ങളുടെ അപേക്ഷ ID {{candidateId}} ആണ്. എന്താണ് ചെയ്യേണ്ടത്?',
};

/** Same message for a returning candidate whose registration never completed. */
export const RETURNING_NO_ID: Localised = {
  en: 'Welcome back, {{name}}. What would you like to do?',
  ta: 'மீண்டும் வரவேற்கிறோம், {{name}}. என்ன செய்ய விரும்புகிறீர்கள்?',
  hi: 'वापस स्वागत है, {{name}}। आप क्या करना चाहेंगे?',
  te: 'మళ్ళీ వచ్చినందుకు స్వాగతం, {{name}}. మీరు ఏం చేయాలనుకుంటున్నారు?',
  ml: 'തിരികെ വന്നതിൽ സന്തോഷം, {{name}}. എന്താണ് ചെയ്യേണ്ടത്?',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §24  Talking to a person
 *
 * The one route to a human a candidate can choose: "Other" on the opening menu,
 * then "Talk to staff". It no longer hands the conversation straight over — the
 * member of staff picking it up used to get a phone number and nothing else,
 * and their first four messages were always the same four questions. Those are
 * asked here instead, so whoever rings back already knows who they are speaking
 * to and has the documents on file.
 *
 * The automatic escalations are untouched, and deliberately so: distress, a
 * report that somebody has demanded money, a legal or medical matter, an
 * under-age date of birth, and two replies the bot could not read all still
 * reach a person immediately, with no questions first. Putting a document
 * checklist in front of a safeguarding report would be the worst thing this
 * file could do.
 * ───────────────────────────────────────────────────────────────────────────*/

export const STAFF_INTAKE_START: Localised = {
  en: 'Of course. Before I pass you to our staff, may I take a few details so they can help you properly?',
  ta: 'கண்டிப்பாக. உங்களை எங்கள் ஊழியரிடம் இணைக்கும் முன், அவர்கள் சரியாக உதவ சில விவரங்களைக் கேட்கலாமா?',
  hi: 'ज़रूर। आपको हमारे स्टाफ से जोड़ने से पहले, कुछ जानकारी ले लूँ ताकि वे आपकी ठीक से मदद कर सकें।',
  te: 'తప్పకుండా. మిమ్మల్ని మా సిబ్బందికి కలిపే ముందు, వాళ్ళు సరిగ్గా సాయం చేయడానికి కొన్ని వివరాలు తీసుకుంటాను.',
  ml: 'തീർച്ചയായും. നിങ്ങളെ ഞങ്ങളുടെ സ്റ്റാഫിലേക്ക് ബന്ധിപ്പിക്കും മുൻപ്, അവർക്ക് ശരിയായി സഹായിക്കാൻ കുറച്ച് വിവരങ്ങൾ എടുക്കട്ടെ?',
};

export const STAFF_INTAKE_COMPLETE: Localised = {
  en: 'Thank you. Our staff will contact you shortly.\nYour reference number is {{enquiryId}} — please keep it for any follow-up.',
  ta: 'நன்றி. எங்கள் ஊழியர் விரைவில் உங்களைத் தொடர்பு கொள்வார்கள்.\nஉங்கள் குறிப்பு எண்: {{enquiryId}} — தொடர்ந்து பேச இதை வைத்திருங்கள்.',
  hi: 'धन्यवाद। हमारा स्टाफ जल्द ही आपसे संपर्क करेगा।\nआपका रेफरेंस नंबर है {{enquiryId}} — आगे बात करने के लिए इसे रखें।',
  te: 'ధన్యవాదాలు. మా సిబ్బంది త్వరలో మిమ్మల్ని సంప్రదిస్తారు.\nమీ రిఫరెన్స్ నంబర్: {{enquiryId}} — తర్వాత మాట్లాడటానికి దీన్ని ఉంచుకోండి.',
  ml: 'നന്ദി. ഞങ്ങളുടെ സ്റ്റാഫ് ഉടൻ നിങ്ങളെ ബന്ധപ്പെടും.\nനിങ്ങളുടെ റഫറൻസ് നമ്പർ {{enquiryId}} ആണ് — തുടർന്നുള്ള ആവശ്യങ്ങൾക്ക് ഇത് സൂക്ഷിക്കൂ.',
};

export const RETURNING_CHOICES: Choice[] = [
  {
    id: 'track',
    label: { en: 'Track application', ta: 'விண்ணப்ப நிலை', hi: 'आवेदन ट्रैक करें', te: 'దరఖాస్తు ట్రాక్', ml: 'അപേക്ഷ ട്രാക്ക്' },
  },
  {
    id: 'check_jobs',
    label: { en: 'Check suitable jobs', ta: 'வேலை வாய்ப்புகள்', hi: 'उपयुक्त नौकरियाँ', te: 'సరైన ఉద్యోగాలు చూడండి', ml: 'യോജിച്ച ജോലികൾ നോക്കാം' },
  },
  { id: 'update', label: { en: 'Update profile', ta: 'விவரம் மாற்ற', hi: 'प्रोफ़ाइल अपडेट', te: 'ప్రొఫైల్ మార్చండి', ml: 'പ്രൊഫൈൽ അപ്ഡേറ്റ്' } },
  {
    id: 'upload_documents',
    label: { en: 'Upload documents', ta: 'ஆவணம் அனுப்ப', hi: 'दस्तावेज़ भेजें', te: 'డాక్యుమెంట్లు పంపండి', ml: 'രേഖകൾ അപ്‌ലോഡ് ചെയ്യുക' },
  },
  { id: 'delete', label: { en: 'Delete profile', ta: 'சுயவிவரம் நீக்க', hi: 'प्रोफ़ाइल हटाएँ', te: 'ప్రొఫైల్ తీసేయండి', ml: 'പ്രൊഫൈൽ ഡിലീറ്റ് ചെയ്യാം' } },
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
  te: 'మీ ప్రొఫైల్ మా టీమ్ దగ్గర ఉంది. దానికి సరిపడే ఖాళీ వచ్చినప్పుడు, మేము ఇక్కడే మీకు మెసేజ్ చేస్తాము. ఇప్పుడున్న ఖాళీల గురించి మా స్టాఫ్ మీకు కాల్ చేయాలా?',
  ml: 'നിങ്ങളുടെ പ്രൊഫൈൽ ഞങ്ങളുടെ ടീമിന്റെ കയ്യിലുണ്ട്. യോജിച്ച ഒഴിവ് വരുമ്പോൾ ഞങ്ങൾ ഇവിടെ മെസേജ് ചെയ്യും. ഇപ്പോൾ ഉള്ള ഒഴിവുകളെക്കുറിച്ച് ഞങ്ങളുടെ സ്റ്റാഫ് നിങ്ങളെ വിളിക്കണോ?',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §21 Reminder
 * ───────────────────────────────────────────────────────────────────────────*/

export const REMINDER: Localised = {
  en: 'Hi {{name}}, your Adira job profile is incomplete. Would you like to continue from where you stopped?',
  ta: 'வணக்கம் {{name}}, உங்கள் அதிரா வேலை விவரங்கள் முழுமையடையவில்லை. நிறுத்திய இடத்திலிருந்து தொடரலாமா?',
  hi: 'नमस्ते {{name}}, आपकी अदिरा जॉब प्रोफ़ाइल अधूरी है। क्या आप वहीं से आगे बढ़ना चाहेंगे जहाँ रुके थे?',
  te: 'నమస్తే {{name}}, మీ Adira ఉద్యోగ ప్రొఫైల్ పూర్తి కాలేదు. మీరు ఆపిన చోటు నుండి కంటిన్యూ చేయాలా?',
  ml: 'ഹായ് {{name}}, നിങ്ങളുടെ Adira ജോലി പ്രൊഫൈൽ പൂർത്തിയായിട്ടില്ല. നിർത്തിയ സ്ഥലത്ത് നിന്ന് തുടരണോ?',
};

/**
 * Three buttons, as §21 specifies. "Not interested" is not among them — a
 * fourth option would push this into a list, and someone who wants out can say
 * so in words or send DELETE, both of which are understood anywhere (§23).
 */
export const REMINDER_CHOICES: Choice[] = [
  { id: 'continue', label: { en: 'Continue', ta: 'தொடரவும்', hi: 'आगे बढ़ें', te: 'కొనసాగించండి', ml: 'തുടരുക' } },
  { id: 'later', label: { en: 'Later', ta: 'பிறகு', hi: 'बाद में', te: 'తర్వాత', ml: 'പിന്നീട്' } },
  { id: 'restart', label: { en: 'Start from first', ta: 'முதலிலிருந்து', hi: 'शुरू से', te: 'మొదటి నుండి', ml: 'ആദ്യം മുതൽ തുടങ്ങാം' } },
];

export const REMINDER_LATER: Localised = {
  en: 'No problem. Message us whenever you are ready and we will continue from here.',
  ta: 'பரவாயில்லை. நீங்கள் தயாராகும்போது அனுப்புங்கள், இங்கிருந்தே தொடர்வோம்.',
  hi: 'कोई बात नहीं। जब आप तैयार हों तब मैसेज करें, हम यहीं से आगे बढ़ेंगे।',
  te: 'పర్వాలేదు. మీరు రెడీ అయినప్పుడు మాకు మెసేజ్ పెట్టండి, మేము ఇక్కడి నుండి కంటిన్యూ చేస్తాము.',
  ml: 'കുഴപ്പമില്ല. തയ്യാറാകുമ്പോൾ ഞങ്ങൾക്ക് മെസേജ് ചെയ്യൂ, ഞങ്ങൾ ഇവിടെ നിന്ന് തുടരും.',
};

export const REMINDER_NOT_INTERESTED: Localised = {
  en: 'Understood, we will not message you about this again. If you change your mind, just message us here.',
  ta: 'சரி, இது குறித்து மீண்டும் தொந்தரவு செய்ய மாட்டோம். மனம் மாறினால் இங்கே அனுப்புங்கள்.',
  hi: 'ठीक है, हम इस बारे में दोबारा मैसेज नहीं करेंगे। मन बदले तो यहीं मैसेज कर दें।',
  te: 'అర్థమైంది, దీని గురించి మేము మీకు ఇక మెసేజ్ చేయము. మీ మనసు మారితే, ఇక్కడే మాకు మెసేజ్ పెట్టండి.',
  ml: 'മനസ്സിലായി, ഇനി ഇതിനെക്കുറിച്ച് ഞങ്ങൾ മെസേജ് ചെയ്യില്ല. മനസ്സ് മാറിയാൽ ഇവിടെ മെസേജ് ചെയ്താൽ മതി.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §22 Update
 * ───────────────────────────────────────────────────────────────────────────*/

export const UPDATE_PROMPT: Localised = {
  en: 'What would you like to update?',
  ta: 'எதைப் புதுப்பிக்க விரும்புகிறீர்கள்?',
  hi: 'आप क्या अपडेट करना चाहेंगे?',
  te: 'మీరు ఏం మార్చాలనుకుంటున్నారు?',
  ml: 'എന്താണ് അപ്ഡേറ്റ് ചെയ്യേണ്ടത്?',
};

export const UPDATE_CHOICES: Choice[] = [
  { id: 'new_experience', label: { en: 'New experience', ta: 'புதிய அனுபவம்', hi: 'नया अनुभव', te: 'కొత్త అనుభవం', ml: 'പുതിയ പരിചയം' } },
  { id: 'new_certificate', label: { en: 'New certificate', ta: 'புதிய சான்றிதழ்', hi: 'नया सर्टिफिकेट', te: 'కొత్త సర్టిఫికెట్', ml: 'പുതിയ സർട്ടിഫിക്കറ്റ്' } },
  { id: 'job_preference', label: { en: 'Job preference', ta: 'வேலை விருப்பம்', hi: 'नौकरी की पसंद', te: 'పని ఇష్టం', ml: 'ജോലി താൽപ്പര്യം' } },
  { id: 'country', label: { en: 'Country preference', ta: 'நாட்டு விருப்பம்', hi: 'देश की पसंद', te: 'దేశం ఇష్టం', ml: 'രാജ്യം താൽപ്പര്യം' } },
  { id: 'documents', label: { en: 'Passport / documents', ta: 'பாஸ்போர்ட்/ஆவணம்', hi: 'पासपोर्ट/दस्तावेज़', te: 'పాస్‌పోర్ట్ / పత్రాలు', ml: 'പാസ്‌പോർട്ട് / രേഖകൾ' } },
  { id: 'availability', label: { en: 'Joining availability', ta: 'சேரும் நேரம்', hi: 'जॉइनिंग उपलब्धता', te: 'చేరిక లభ్యత', ml: 'ജോലിയിൽ ചേരാനുള്ള സമയം' } },
  { id: 'contact', label: { en: 'Contact details', ta: 'தொடர்பு விவரம்', hi: 'संपर्क जानकारी', te: 'సంప్రదింపు వివరాలు', ml: 'ബന്ധപ്പെടാനുള്ള വിവരങ്ങൾ' } },
];

export const UPDATE_SAVED: Localised = {
  en: 'Updated ✅ Your profile has been changed.',
  ta: 'புதுப்பிக்கப்பட்டது ✅ உங்கள் விவரங்கள் மாற்றப்பட்டன.',
  hi: 'अपडेट हो गया ✅ आपकी प्रोफ़ाइल बदल दी गई है।',
  te: 'అప్‌డేట్ అయ్యింది ✅ మీ ప్రొఫైల్ మార్చాము.',
  ml: 'അപ്ഡേറ്റ് ചെയ്തു ✅ നിങ്ങളുടെ പ്രൊഫൈൽ മാറ്റിയിട്ടുണ്ട്.',
};

/**
 * One more thing after "you're registered".
 *
 * Sent when the CRM's CV policy turns out to require a CV the bot did not ask
 * for. Deliberately does not apologise or explain the disagreement between two
 * systems — that is our problem, not theirs — and deliberately does not say the
 * registration is incomplete, because it is not: they answered everything they
 * were asked and they keep their Application ID.
 */
export const CRM_NEEDS_CV: Localised = {
  en: 'One more thing — for this role we do need your CV after all. Please send it as a PDF, Word file or clear photo.',
  ta: 'இன்னும் ஒன்று — இந்த வேலைக்கு உங்கள் CV தேவைப்படுகிறது. PDF, Word கோப்பு அல்லது தெளிவான புகைப்படமாக அனுப்பவும்.',
  hi: 'एक और बात — इस काम के लिए आपका CV चाहिए होगा। कृपया इसे PDF, Word फ़ाइल या साफ़ फ़ोटो के रूप में भेजें।',
  te: 'ఇంకొక్క విషయం — ఈ ఉద్యోగానికి మీ CV కావాలి. దయచేసి PDF, Word ఫైల్ లేదా క్లియర్ ఫోటోగా పంపండి.',
  ml: 'ഒരു കാര്യം കൂടി — ഈ ജോലിക്ക് നിങ്ങളുടെ CV വേണം. PDF ആയോ Word ഫയൽ ആയോ വ്യക്തമായ ഫോട്ടോ ആയോ അയക്കൂ.',
};

export const SEND_CERTIFICATE: Localised = {
  en: 'Please send the certificate as a PDF or a clear photo.',
  ta: 'சான்றிதழை PDF ஆகவோ தெளிவான புகைப்படமாகவோ அனுப்பவும்.',
  hi: 'कृपया सर्टिफिकेट PDF या साफ़ फ़ोटो के रूप में भेजें।',
  te: 'దయచేసి సర్టిఫికెట్‌ను PDF గా లేదా క్లియర్‌గా ఉన్న ఫోటోగా పంపండి.',
  ml: 'സർട്ടിഫിക്കറ്റ് PDF ആയോ വ്യക്തമായ ഫോട്ടോ ആയോ അയക്കൂ.',
};

export const SEND_DOCUMENTS: Localised = {
  en: 'Please send the document you would like to add.',
  ta: 'சேர்க்க விரும்பும் ஆவணத்தை அனுப்பவும்.',
  hi: 'जो दस्तावेज़ जोड़ना है वह भेजें।',
  te: 'మీరు యాడ్ చేయాలనుకుంటున్న డాక్యుమెంట్‌ను పంపండి.',
  ml: 'നിങ്ങൾക്ക് ചേർക്കേണ്ട രേഖ അയക്കൂ.',
};

export const CONTACT_PROMPT: Localised = {
  en: 'Please type the phone number or email you would like us to use.',
  ta: 'நாங்கள் பயன்படுத்த வேண்டிய தொலைபேசி எண் அல்லது மின்னஞ்சலைத் தட்டச்சு செய்யவும்.',
  hi: 'कृपया वह फ़ोन नंबर या ईमेल टाइप करें जो हमें इस्तेमाल करना चाहिए।',
  te: 'మేము వాడాలనుకునే ఫోన్ నంబర్ లేదా ఈమెయిల్‌ను టైప్ చేయండి.',
  ml: 'ഞങ്ങൾ ഉപയോഗിക്കേണ്ട ഫോൺ നമ്പറോ ഇമെയിലോ ടൈപ്പ് ചെയ്യൂ.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §23 Delete
 * ───────────────────────────────────────────────────────────────────────────*/

export const DELETE_CONFIRM: Localised = {
  en: 'Would you like us to delete your candidate profile and stop future job messages?',
  ta: 'உங்கள் சுயவிவரத்தை நீக்கி, இனி வேலை தொடர்பான செய்திகளை நிறுத்த வேண்டுமா?',
  hi: 'क्या आप चाहते हैं कि हम आपकी प्रोफ़ाइल हटा दें और आगे नौकरी के मैसेज बंद कर दें?',
  te: 'మీ క్యాండిడేట్ ప్రొఫైల్‌ను డిలీట్ చేసి, ముందు ముందు జాబ్ మెసేజీలు పంపకుండా ఆపాలా?',
  ml: 'നിങ്ങളുടെ കാൻഡിഡേറ്റ് പ്രൊഫൈൽ ഡിലീറ്റ് ചെയ്ത് ഇനി ജോലി സംബന്ധിച്ച മെസ്സേജുകൾ അയക്കാതിരിക്കണോ?',
};

export const DELETE_CHOICES: Choice[] = [
  { id: 'delete_yes', label: { en: 'Yes, delete', ta: 'ஆம், நீக்கவும்', hi: 'हाँ, हटाएँ', te: 'అవును, DELETE చేయండి', ml: 'അതെ, DELETE ചെയ്യുക' } },
  { id: 'delete_no', label: { en: 'Cancel', ta: 'வேண்டாம்', hi: 'रहने दें', te: 'రద్దు చేయండి', ml: 'റദ്ദാക്കുക' } },
];

export const DELETED: Localised = {
  en: 'Your profile has been removed and we will not send you job messages. If you want to register again, just message us here.',
  ta: 'உங்கள் சுயவிவரம் நீக்கப்பட்டது; இனி வேலை செய்திகள் அனுப்பப்படாது. மீண்டும் பதிவு செய்ய விரும்பினால் இங்கே அனுப்புங்கள்.',
  hi: 'आपकी प्रोफ़ाइल हटा दी गई है और अब हम नौकरी के मैसेज नहीं भेजेंगे। दोबारा रजिस्टर करना हो तो यहीं मैसेज करें।',
  te: 'మీ ప్రొఫైల్‌ను తీసేశాము, ఇక మీకు జాబ్ మెసేజీలు పంపము. మళ్ళీ రిజిస్టర్ చేసుకోవాలంటే, ఇక్కడ మాకు మెసేజ్ పెట్టండి.',
  ml: 'നിങ്ങളുടെ പ്രൊഫൈൽ നീക്കം ചെയ്തു, ഇനി ഞങ്ങൾ ജോലി മെസ്സേജുകൾ അയക്കില്ല. വീണ്ടും രജിസ്റ്റർ ചെയ്യണമെങ്കിൽ ഇവിടെ മെസ്സേജ് അയക്കൂ.',
};

export const DELETE_CANCELLED: Localised = {
  en: 'Nothing has been deleted. Your profile is unchanged.',
  ta: 'எதுவும் நீக்கப்படவில்லை. உங்கள் விவரங்கள் அப்படியே உள்ளன.',
  hi: 'कुछ भी नहीं हटाया गया। आपकी प्रोफ़ाइल जैसी थी वैसी ही है।',
  te: 'ఏమీ డిలీట్ చేయలేదు. మీ ప్రొఫైల్ అలాగే ఉంది.',
  ml: 'ഒന്നും ഡിലീറ്റ് ചെയ്തിട്ടില്ല. നിങ്ങളുടെ പ്രൊഫൈലിന് മാറ്റമില്ല.',
};

/* ─────────────────────────────────────────────────────────────────────────────
 * §24 Staff escalation
 * ───────────────────────────────────────────────────────────────────────────*/

export const STAFF_HANDOFF: Localised = {
  en: 'I am passing you to one of our staff. They will reply here shortly.',
  ta: 'உங்களை எங்கள் ஊழியரிடம் இணைக்கிறேன். விரைவில் இங்கே பதிலளிப்பார்கள்.',
  hi: 'मैं आपको हमारे स्टाफ से जोड़ रहा हूँ। वे जल्द ही यहीं जवाब देंगे।',
  te: 'మిమ్మల్ని మా స్టాఫ్‌లో ఒకరికి కలుపుతున్నాను. వాళ్ళు కాసేపట్లో ఇక్కడే రిప్లై ఇస్తారు.',
  ml: 'ഞാൻ നിങ്ങളെ ഞങ്ങളുടെ സ്റ്റാഫിലേക്ക് കൈമാറുന്നു. അവർ ഇവിടെ വേഗം മറുപടി തരും.',
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
  te: 'అది మా స్టాఫ్ మిమ్మల్ని కాంటాక్ట్ చేసినప్పుడు చెప్తారు. ముందు మీ రిజిస్ట్రేషన్ పూర్తి చేయనివ్వండి.',
  ml: 'അതിന് ഞങ്ങളുടെ സ്റ്റാഫ് നിങ്ങളെ ബന്ധപ്പെടുമ്പോൾ മറുപടി പറയും. ആദ്യം നിങ്ങളുടെ രജിസ്ട്രേഷൻ തീർക്കട്ടെ.',
};

/**
 * Sent when a reply could not be recorded as an answer.
 *
 * Says what is needed rather than only what went wrong — "I did not follow
 * that" on its own tells the candidate nothing about what to do next. The
 * question always follows in the same message, with a way to reach a person.
 */
/**
 * Sent when a candidate taps a button from an earlier question.
 *
 * WhatsApp leaves every interactive message tappable forever — scrolling back
 * and pressing an old option is easy to do by accident. Those taps must not be
 * scored against whatever question is open now: several steps offer a "Yes",
 * so a stale tap can otherwise be recorded as an answer to a question it was
 * never about.
 */
export const OPTION_EXPIRED: Localised = {
  en: 'That option belonged to an earlier question and is no longer active. Here is where we are now.',
  ta: 'அந்த விருப்பம் முந்தைய கேள்விக்கானது, இப்போது செயலில் இல்லை. நாம் இப்போது இருக்கும் இடம் இதோ.',
  hi: 'वह विकल्प पिछले सवाल का था और अब सक्रिय नहीं है। हम अभी यहाँ हैं।',
  te: 'ఆ ఆప్షన్ ముందు అడిగిన ప్రశ్నదే, ఇప్పుడు అది పనిచేయదు. మనం ఇప్పుడు ఇక్కడ ఉన్నాం.',
  ml: 'ആ ഓപ്ഷൻ മുൻപത്തെ ഒരു ചോദ്യത്തിന്റേതായിരുന്നു, അത് ഇപ്പോൾ ഇല്ല. ഇപ്പോൾ നമ്മൾ എവിടെയാണെന്ന് ഇതാ.',
};

export const UNCLEAR: Localised = {
  en: 'Sorry, I could not use that as an answer. Please reply to the question below.',
  ta: 'மன்னிக்கவும், அதைப் பதிலாகப் பயன்படுத்த முடியவில்லை. கீழே உள்ள கேள்விக்குப் பதிலளிக்கவும்.',
  hi: 'माफ़ कीजिए, मैं इसे जवाब के रूप में नहीं ले सका। कृपया नीचे दिए गए सवाल का जवाब दें।',
  te: 'క్షమించండి, దాన్ని జవాబుగా తీసుకోలేకపోయాం. దయచేసి కింద ఉన్న ప్రశ్నకు జవాబు ఇవ్వండి.',
  ml: 'സോറി, അത് ഉത്തരമായി എടുക്കാൻ പറ്റിയില്ല. താഴെയുള്ള ചോദ്യത്തിന് മറുപടി തരൂ.',
};

/** Asked when a question has been re-asked too often — a person does better. */
export const STUCK: Localised = {
  en: 'Let me pass this to one of our staff so they can help you directly.',
  ta: 'இதை எங்கள் ஊழியரிடம் தருகிறேன், அவர்கள் நேரடியாக உதவுவார்கள்.',
  hi: 'मैं इसे हमारे स्टाफ को दे देता हूँ ताकि वे सीधे आपकी मदद कर सकें।',
  te: 'దీన్ని మా సిబ్బందిలో ఒకరికి పంపిస్తాను, వాళ్ళు మీకు నేరుగా సాయం చేస్తారు.',
  ml: 'ഇത് ഞങ്ങളുടെ സ്റ്റാഫിൽ ഒരാൾക്ക് കൈമാറാം, അവർക്ക് നേരിട്ട് നിങ്ങളെ സഹായിക്കാൻ പറ്റും.',
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
  te: 'మీ వాయిస్ మెసేజ్‌ని మా సిబ్బంది కోసం సేవ్ చేశాను. సరిగ్గా నమోదు చేయడానికి, దయచేసి ఒక ఆప్షన్ నొక్కండి లేదా జవాబు టైప్ చేయండి.',
  ml: 'നിങ്ങളുടെ വോയിസ് മെസ്സേജ് ഞങ്ങളുടെ സ്റ്റാഫിന് വേണ്ടി സേവ് ചെയ്തിട്ടുണ്ട്. ശരിയായി രേഖപ്പെടുത്താൻ, ഒരു ഓപ്ഷൻ ടാപ്പ് ചെയ്യുകയോ ഉത്തരം ടൈപ്പ് ചെയ്യുകയോ ചെയ്യാമോ?',
};

/** Sent when a candidate messages while staff have taken the conversation over (§24). */
export const STAFF_IN_CHARGE: Localised = {
  en: 'One of our staff is looking after this conversation. They will reply here.',
  ta: 'இந்த உரையாடலை எங்கள் ஊழியர் ஒருவர் கவனித்து வருகிறார். அவர்கள் இங்கே பதிலளிப்பார்கள்.',
  hi: 'हमारा एक स्टाफ मेंबर इस बातचीत को देख रहा है। वे यहीं जवाब देंगे।',
  te: 'ఈ సంభాషణను మా సిబ్బందిలో ఒకరు చూసుకుంటున్నారు. వాళ్ళు ఇక్కడే జవాబు ఇస్తారు.',
  ml: 'ഞങ്ങളുടെ സ്റ്റാഫിൽ ഒരാൾ ഈ സംഭാഷണം നോക്കുന്നുണ്ട്. അവർ ഇവിടെ മറുപടി തരും.',
};

/** §27 — below the minimum age the flow stops and a person takes over. */
export const AGE_HANDOFF: Localised = {
  en: 'Thank you. One of our staff will contact you about your application.',
  ta: 'நன்றி. உங்கள் விண்ணப்பம் குறித்து எங்கள் ஊழியர் ஒருவர் தொடர்பு கொள்வார்.',
  hi: 'धन्यवाद। आपके आवेदन के बारे में हमारा स्टाफ आपसे संपर्क करेगा।',
  te: 'ధన్యవాదాలు. మీ అప్లికేషన్ గురించి మా సిబ్బందిలో ఒకరు మిమ్మల్ని సంప్రదిస్తారు.',
  ml: 'നന്ദി. നിങ്ങളുടെ അപേക്ഷയെക്കുറിച്ച് ഞങ്ങളുടെ സ്റ്റാഫിൽ ഒരാൾ നിങ്ങളെ ബന്ധപ്പെടും.',
};
