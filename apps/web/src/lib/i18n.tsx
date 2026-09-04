/**
 * AGRIFUR2 interface i18n — English / हिन्दी / मराठी.
 *
 * UI chrome (navigation, headings, buttons, table headers) is translated.
 * Provenance vocabulary (OBSERVED, DERIVED, AUTH_REQUIRED, …) stays canonical
 * so data states never get lost in translation; provider/variable names are
 * kept as-is. Missing keys fall back to English.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "hi" | "mr";

type Entry = [en: string, hi: string, mr: string];

const DICT: Record<string, Entry> = {
  // ---------------------------------------------------------------- shell
  "nav.world": ["World model", "फ़ील्ड विश्व मॉडल", "फील्ड वर्ल्ड मॉडेल"],
  "nav.twin": ["Digital Twin 3D", "डिजिटल ट्विन 3D", "डिजिटल ट्विन 3D"],
  "nav.evidence": ["Evidence", "साक्ष्य", "पुरावा"],
  "nav.weather": ["Weather", "मौसम", "हवामान"],
  "nav.water": ["Water", "जल", "पाणी"],
  "nav.soil": ["Soil", "मिट्टी", "माती"],
  "nav.terrain": ["Terrain", "भू-आकृति", "भूप्रदेश"],
  "nav.crop": ["Crop", "फ़सल", "पीक"],
  "nav.intelligence": ["Intelligence", "बुद्धिमत्ता", "बुद्धिमत्ता"],
  "nav.investigations": ["Investigations", "जाँच", "तपासणी"],
  "nav.satellite": ["Satellite", "उपग्रह", "उपग्रह"],
  "nav.sensors": ["Sensors", "सेंसर", "सेन्सर"],
  "nav.simulation": ["Simulation", "सिमुलेशन", "सिम्युलेशन"],
  "nav.history": ["History", "इतिहास", "इतिहास"],
  "nav.assistant": ["AI assistant", "AI सहायक", "AI सहाय्यक"],
  "nav.system": ["System", "सिस्टम", "प्रणाली"],
  "nav.fields": ["Farms & fields", "खेत और फ़ील्ड", "शेत आणि प्लॉट"],
  "sec.layers": ["Evidence layers", "साक्ष्य परतें", "पुराव्याचे थर"],
  "sec.intel": ["Intelligence & workspaces", "बुद्धिमत्ता और कार्यक्षेत्र", "बुद्धिमत्ता आणि कार्यक्षेत्र"],
  "shell.farmModel": ["farm world model", "फ़ार्म विश्व मॉडल", "शेती वर्ल्ड मॉडेल"],
  "shell.activeField": ["Active field", "सक्रिय फ़ील्ड", "सक्रिय प्लॉट"],
  "shell.noFields": ["No fields yet", "अभी कोई फ़ील्ड नहीं", "अजून प्लॉट नाही"],
  "shell.selectField": ["Select a field", "फ़ील्ड चुनें", "प्लॉट निवडा"],
  "shell.live": ["live", "लाइव", "लाइव्ह"],
  "assist.tapToTalk": ["Tap to speak", "बोलने के लिए टैप करें", "बोलण्यासाठी टॅप करा"],
  "assist.listening": ["Listening… speak now", "सुन रहे हैं… बोलिए", "ऐकत आहे… बोला"],
  "assist.processing": ["Preparing answer…", "उत्तर तैयार हो रहा है…", "उत्तर तयार करत आहे…"],
  "assist.answering": ["Playing answer…", "उत्तर सुनें…", "उत्तर ऐका…"],
  "assist.noSpeech": ["No speech detected — try again.", "कोई आवाज़ नहीं मिली — फिर कोशिश करें।", "आवाज आढळली नाही — पुन्हा प्रयत्न करा."],
  "assist.micDenied": [
    "Microphone access denied — allow the microphone and try again.",
    "माइक्रोफ़ोन की अनुमति नहीं मिली — अनुमति दें और फिर कोशिश करें।",
    "मायक्रोफोनची परवानगी नाकारली — परवानगी द्या आणि पुन्हा प्रयत्न करा."
  ],
  "assist.micError": ["Microphone unavailable on this device.", "इस डिवाइस पर माइक्रोफ़ोन उपलब्ध नहीं है।", "या डिव्हाइसवर मायक्रोफोन उपलब्ध नाही."],
  "assist.typeInstead": ["or type your question", "या अपना प्रश्न लिखें", "किंवा तुमचा प्रश्न टाइप करा"],
  "assist.send": ["Send", "भेजें", "पाठवा"],
  "assist.stop": ["Stop", "रोकें", "थांबवा"],
  "assist.ttsMuted": ["Voice replies are muted.", "आवाज़ उत्तर बंद हैं।", "आवाज उत्तर बंद आहेत."],
  "assist.fieldDataUsed": ["AGRIFUR field data used", "AGRIFUR फ़ील्ड डेटा उपयोग", "AGRIFUR प्लॉट डेटा वापरला"],
  "shell.reconnecting": ["reconnecting…", "पुनः कनेक्ट हो रहा…", "पुन्हा जोडत आहे…"],
  "shell.recentEvents": ["{n} recent events", "{n} हाल की घटनाएँ", "{n} अलीकडील घटना"],
  "shell.fieldBadge": ["field: {name}", "फ़ील्ड: {name}", "प्लॉट: {name}"],
  "shell.signOut": ["Sign out", "साइन आउट", "साइन आउट"],
  "shell.createField": ["+ Create field", "+ फ़ील्ड बनाएँ", "+ प्लॉट तयार करा"],
  "shell.loading": ["Loading your workspace…", "आपका कार्यक्षेत्र लोड हो रहा है…", "तुमचे कार्यक्षेत्र लोड होत आहे…"],
  "shell.opening": ["Opening your workspace…", "कार्यक्षेत्र खुल रहा है…", "कार्यक्षेत्र उघडत आहे…"],
  "shell.noFieldsTitle": ["No fields yet", "अभी कोई फ़ील्ड नहीं", "अजून प्लॉट नाही"],
  "shell.noFieldsBody": [
    "Create a farm and draw your first field boundary to build its world model.",
    "खेत बनाएँ और अपनी पहली फ़ील्ड की सीमा बनाकर उसका विश्व मॉडल बनाएँ।",
    "शेत तयार करा आणि तुमचा पहिला प्लॉट काढून त्याचे वर्ल्ड मॉडेल बनवा.",
  ],
  "shell.createFieldBtn": ["Create field", "फ़ील्ड बनाएँ", "प्लॉट तयार करा"],
  "shell.selectTitle": ["Select a field", "फ़ील्ड चुनें", "प्लॉट निवडा"],
  "shell.selectBody": [
    "Pick a field from the selector to load its evidence, world model and intelligence.",
    "साक्ष्य, विश्व मॉडल और बुद्धिमत्ता लोड करने के लिए चयनकर्ता से फ़ील्ड चुनें।",
    "पुरावा, वर्ल्ड मॉडेल आणि बुद्धिमत्ता लोड करण्यासाठी निवडकर्त्यातून प्लॉट निवडा.",
  ],
  "lang.label": ["Language", "भाषा", "भाषा"],
  "lang.en": ["English", "English", "English"],
  "lang.hi": ["हिन्दी", "हिन्दी", "हिन्दी"],
  "lang.mr": ["मराठी", "मराठी", "मराठी"],

  // -------------------------------------------------------------- landing
  "land.signIn": ["Sign in", "साइन इन", "साइन इन"],
  "land.enterField": ["Enter the field", "फ़ील्ड में प्रवेश करें", "प्लॉटमध्ये प्रवेश करा"],
  "land.pill1": ["Field-centric farm world model", "फ़ील्ड-केंद्रित फ़ार्म विश्व मॉडल", "प्लॉट-केंद्रित शेती वर्ल्ड मॉडेल"],
  "land.pill2": ["Evidence-driven", "साक्ष्य-आधारित", "पुरावा-आधारित"],
  "land.pill3": ["Uncertainty-aware", "अनिश्चितता-जागरूक", "अनिश्चितता-जागरूक"],
  "land.pill4": ["Provenance-first", "उद्गम-प्रथम", "उगम-प्रथम"],
  "land.titleA": ["The", "वह", "ते"],
  "land.titleGrad": ["farm world model", "फ़ार्म विश्व मॉडल", "शेती वर्ल्ड मॉडेल"],
  "land.titleB": ["you can actually trust.", "जिस पर आप सच में भरोसा कर सकते हैं।", "ज्यावर तुम्ही खरोखर विश्वास ठेवू शकता."],
  "land.sub": [
    "AGRIFUR2 fuses physical sensors, satellite Earth observation, weather, water, soil and terrain into one geographically anchored model of your field — then reasons over that evidence with anomaly, risk, uncertainty, contradiction and investigation engines. Every number states where it came from.",
    "AGRIFUR2 भौतिक सेंसर, उपग्रह पृथ्वी अवलोकन, मौसम, जल, मिट्टी और भू-आकृति को आपके फ़ील्ड के एक भौगोलिक रूप से जुड़े मॉडल में मिलाता है — फिर विसंगति, जोखिम, अनिश्चितता, विरोधाभास और जाँच इंजनों से उस साक्ष्य पर तर्क करता है। हर संख्या बताती है कि वह कहाँ से आई।",
    "AGRIFUR2 भौतिक सेन्सर, उपग्रह पृथ्वी निरीक्षण, हवामान, पाणी, माती आणि भूप्रदेश तुमच्या प्लॉटच्या एका भौगोलिकदृष्ट्या जोडलेल्या मॉडेलमध्ये एकत्र करतो — मग त्या पुराव्यावर विसंगती, जोखीम, अनिश्चितता, विरोधाभास आणि तपासणी इंजिनांनी तर्क करतो. प्रत्येक संख्या सांगते ती कुठून आली.",
  ],
  "land.ctaBuild": ["Build your field model", "अपना फ़ील्ड मॉडल बनाएँ", "तुमचे फील्ड मॉडेल तयार करा"],
  "land.ctaExplore": ["Explore the workspace →", "कार्यक्षेत्र देखें →", "कार्यक्षेत्र पहा →"],
  "land.sec1Title": ["What sits behind every field", "हर फ़ील्ड के पीछे क्या है", "प्रत्येक प्लॉटमागे काय आहे"],
  "land.sec1Body": [
    "AGRIFUR2 is not a dashboard with cards. It is an eight-layer evidence stack that flows through quality validation, fusion and reasoning into a living world model — and back out into investigations and actions.",
    "AGRIFUR2 कार्ड वाला डैशबोर्ड नहीं है। यह आठ-परत साक्ष्य स्टैक है जो गुणवत्ता सत्यापन, संलयन और तर्क से होकर एक जीवंत विश्व मॉडल में प्रवाहित होता है — और वापस जाँच और कार्यों में।",
    "AGRIFUR2 हे कार्डचे डॅशबोर्ड नाही. ते आठ-स्तर पुरावा स्टॅक आहे जे गुणवत्ता सत्यापन, संलयन आणि तर्कातून जिवंत वर्ल्ड मॉडेलमध्ये वाहते — आणि परत तपासणी व कृतींमध्ये.",
  ],
  "land.pipeTitle": ["The evidence pipeline", "साक्ष्य पाइपलाइन", "पुरावा पाइपलाइन"],
  "land.layersTitle": ["The eight evidence layers", "आठ साक्ष्य परतें", "आठ पुरावा स्तर"],
  "land.sec2Title": ["Start with one field.", "एक फ़ील्ड से शुरू करें।", "एका प्लॉटपासून सुरुवात करा."],
  "land.sec2Body": [
    "Draw your boundary on the map, name your crop, and the system begins collecting real provider evidence — scheduled, labelled, and honest about what it does not know.",
    "नक्शे पर अपनी सीमा बनाएँ, अपनी फ़सल का नाम दें, और सिस्टम वास्तविक प्रदाता साक्ष्य एकत्र करना शुरू कर देता है — अनुसूचित, लेबल किया हुआ, और जो नहीं जानता उसके बारे में स्पष्ट।",
    "नकाशावर तुमची सीमा काढा, तुमच्या पिकाचे नाव द्या, आणि प्रणाली वास्तविक प्रदाता पुरावा गोळा करण्यास सुरुवात करते — नियोजित, लेबल केलेला, आणि जे माहीत नाही त्याबद्दल प्रामाणिक.",
  ],
  "land.ctaCreate": ["Create your farm", "अपना खेत बनाएँ", "तुमचे शेत तयार करा"],
  "land.footer": [
    "AGRIFUR2 — agricultural intelligence operating system · Truthfulness policy: no fabricated observations, no fake imagery, no invented confidence.",
    "AGRIFUR2 — कृषि बुद्धिमत्ता ऑपरेटिंग सिस्टम · सत्यता नीति: कोई काल्पनिक अवलोकन नहीं, कोई नकली इमेजरी नहीं, कोई गढ़ा हुआ आत्मविश्वास नहीं।",
    "AGRIFUR2 — कृषी बुद्धिमत्ता ऑपरेटिंग सिस्टम · सत्यता धोरण: कोणतेही काल्पनिक निरीक्षण नाही, बनावट प्रतिमा नाही, शोधलेला आत्मविश्वास नाही.",
  ],
  "land.pillar1t": ["Geographically anchored", "भौगोलिक रूप से जुड़ा", "भौगोलिकदृष्ट्या जोडलेले"],
  "land.pillar1b": [
    "Every field is a real GeoJSON polygon. Evidence, intelligence and history are bound to that geometry — never to a generic location.",
    "हर फ़ील्ड एक वास्तविक GeoJSON बहुभुज है। साक्ष्य, बुद्धिमत्ता और इतिहास उस ज्यामिति से जुड़े हैं — कभी किसी सामान्य स्थान से नहीं।",
    "प्रत्येक प्लॉट हा खरा GeoJSON बहुभुज आहे. पुरावा, बुद्धिमत्ता आणि इतिहास त्या भूमितीशी जोडलेले आहेत — कधीही सामान्य ठिकाणाशी नाही.",
  ],
  "land.pillar2t": ["Provenance-first", "उद्गम-प्रथम", "उगम-प्रथम"],
  "land.pillar2b": [
    "Every value carries a truth state: OBSERVED, DERIVED, ESTIMATED, PREDICTED, SIMULATED or UNKNOWN. Unavailable providers are reported honestly.",
    "हर मान में एक सत्य अवस्था होती है: OBSERVED, DERIVED, ESTIMATED, PREDICTED, SIMULATED या UNKNOWN। अनुपलब्ध प्रदाता ईमानदारी से बताए जाते हैं।",
    "प्रत्येक मूल्यामध्ये सत्य स्थिती असते: OBSERVED, DERIVED, ESTIMATED, PREDICTED, SIMULATED किंवा UNKNOWN. अनुपलब्ध प्रदाता प्रामाणिकपणे नोंदवले जातात.",
  ],
  "land.pillar3t": ["Earth observation", "पृथ्वी अवलोकन", "पृथ्वी निरीक्षण"],
  "land.pillar3b": [
    "STAC discovery against Sentinel-2 / Sentinel-1 catalogs. Acquisitions, cloud cover, resolution — metadata only, never fake imagery. Landsat needs a separate credential-gated USGS adapter and honestly reports AUTH_REQUIRED until one is configured.",
    "Sentinel-2 / Sentinel-1 कैटलॉग के विरुद्ध STAC खोज। अधिग्रहण, बादल आवरण, रिज़ॉल्यूशन — केवल मेटाडेटा, कभी नकली इमेजरी नहीं। Landsat के लिए अलग क्रेडेंशियल-गेटेड USGS एडेप्टर चाहिए और कॉन्फ़िगर होने तक AUTH_REQUIRED बताता है।",
    "Sentinel-2 / Sentinel-1 कॅटलॉगविरुद्ध STAC शोध. संपादने, ढग आवरण, रिझोल्यूशन — फक्त मेटाडेटा, कधीही बनावट प्रतिमा नाही. Landsat साठी वेगळा क्रेडेन्शियल-गेटेड USGS अ‍ॅडॅप्टर आवश्यक आहे आणि कॉन्फिगर होईपर्यंत AUTH_REQUIRED सांगतो.",
  ],
  "land.pillar4t": ["Water intelligence", "जल बुद्धिमत्ता", "पाणी बुद्धिमत्ता"],
  "land.pillar4b": [
    "Weather-driven water balance, ET0 vs precipitation, and root-zone context — with explicit uncertainty when sensors are absent.",
    "मौसम-संचालित जल संतुलन, ET0 बनाम वर्षा, और रूट-ज़ोन संदर्भ — सेंसर न होने पर स्पष्ट अनिश्चितता के साथ।",
    "हवामान-आधारित पाणी शिल्लक, ET0 विरुद्ध पर्जन्य, आणि मुळ-क्षेत्र संदर्भ — सेन्सर नसल्यास स्पष्ट अनिश्चिततेसह.",
  ],
  "land.pillar5t": ["Physical sensors", "भौतिक सेंसर", "भौतिक सेन्सर"],
  "land.pillar5b": [
    "Hardware gateway endpoints with dedupe and provenance. Telemetry is OBSERVED or NO_DATA — never invented.",
    "डीडुप और उद्गम के साथ हार्डवेयर गेटवे एंडपॉइंट। टेलीमेट्री OBSERVED या NO_DATA है — कभी काल्पनिक नहीं।",
    "डीडुप आणि उगमासह हार्डवेअर गेटवे एंडपॉइंट्स. टेलिमेट्री OBSERVED किंवा NO_DATA आहे — कधीही काल्पनिक नाही.",
  ],
  "land.pillar6t": ["Reasoning engines", "तर्क इंजन", "तर्क इंजिने"],
  "land.pillar6b": [
    "Anomaly, risk, uncertainty, contradiction, investigation and hypothesis engines run over real evidence only.",
    "विसंगति, जोखिम, अनिश्चितता, विरोधाभास, जाँच और परिकल्पना इंजन केवल वास्तविक साक्ष्य पर चलते हैं।",
    "विसंगती, जोखीम, अनिश्चितता, विरोधाभास, तपासणी आणि गृहीतक इंजिने फक्त वास्तविक पुराव्यावर चालतात.",
  ],
  "land.layer1": ["1 · Physical hardware", "1 · भौतिक हार्डवेयर", "1 · भौतिक हार्डवेअर"],
  "land.layer2": ["2 · Earth observation", "2 · पृथ्वी अवलोकन", "2 · पृथ्वी निरीक्षण"],
  "land.layer3": ["3 · Water intelligence", "3 · जल बुद्धिमत्ता", "3 · पाणी बुद्धिमत्ता"],
  "land.layer4": ["4 · Environment · soil · terrain", "4 · पर्यावरण · मिट्टी · भू-आकृति", "4 · पर्यावरण · माती · भूप्रदेश"],
  "land.layer5": ["5 · Agriculture · crop", "5 · कृषि · फ़सल", "5 · कृषी · पीक"],
  "land.layer6": ["6 · History", "6 · इतिहास", "6 · इतिहास"],
  "land.layer7": ["7 · Farmer input", "7 · किसान इनपुट", "7 · शेतकरी इनपुट"],
  "land.layer8": ["8 · Simulation / virtual twin", "8 · सिमुलेशन / वर्चुअल ट्विन", "8 · सिम्युलेशन / व्हर्च्युअल ट्विन"],

  // ----------------------------------------------------------------- auth
  "auth.sub": ["Field-centric intelligence", "फ़ील्ड-केंद्रित बुद्धिमत्ता", "प्लॉट-केंद्रित बुद्धिमत्ता"],
  "auth.signIn": ["Sign in", "साइन इन", "साइन इन"],
  "auth.createAccount": ["Create account", "खाता बनाएँ", "खाते तयार करा"],
  "auth.fullName": ["Full name", "पूरा नाम", "पूर्ण नाव"],
  "auth.email": ["Email", "ईमेल", "ईमेल"],
  "auth.password": ["Password", "पासवर्ड", "पासवर्ड"],
  "auth.namePh": ["Farmer name", "किसान का नाम", "शेतकरी नाव"],
  "auth.emailPh": ["you@farm.com", "you@farm.com", "you@farm.com"],
  "auth.passPhReg": ["At least 8 characters", "कम से कम 8 अक्षर", "किमान 8 अक्षरे"],
  "auth.passPhLogin": ["Your password", "आपका पासवर्ड", "तुमचा पासवर्ड"],
  "auth.working": ["Working…", "कार्य हो रहा…", "काम चालू आहे…"],
  "auth.signingIn": ["Signing in…", "साइन इन हो रहा…", "साइन इन होत आहे…"],
  "auth.creating": ["Creating account…", "खाता बन रहा…", "खाते तयार होत आहे…"],
  "auth.useDemo": ["Use demo account (development seed)", "डेमो खाता उपयोग करें (विकास सीड)", "डेमो खाते वापरा (विकास सीड)"],
  "auth.demoErr": ["The development demo account is not available — register a new account instead.", "विकास डेमो खाता उपलब्ध नहीं है — इसके बजाय नया खाता बनाएँ।", "विकास डेमो खाते उपलब्ध नाही — त्याऐवजी नवीन खाते तयार करा."],
  "auth.err": ["Something went wrong. Try again.", "कुछ गलत हो गया। पुनः प्रयास करें।", "काहीतरी चूक झाली. पुन्हा प्रयत्न करा."],
  "auth.footer": [
    "Registration is open. Credentials are hashed and stored server-side; provider secrets never reach the browser.",
    "पंजीकरण खुला है। क्रेडेंशियल हैश किए जाते हैं और सर्वर पर संग्रहीत होते हैं; प्रदाता रहस्य कभी ब्राउज़र तक नहीं पहुँचते।",
    "नोंदणी खुली आहे. क्रेडेन्शियल्स हॅश होऊन सर्व्हरवर साठवले जातात; प्रदाता रहस्य कधीही ब्राउझरपर्यंत पोहोचत नाहीत.",
  ],
  "auth.back": ["← Back to landing", "← लैंडिंग पर वापस", "← मुख्यपृष्ठावर परत"],

  // --------------------------------------------------------------- common
  "c.domain": ["Domain", "क्षेत्र", "क्षेत्र"],
  "c.measurement": ["Measurement", "माप", "माप"],
  "c.value": ["Value", "मान", "मूल्य"],
  "c.state": ["State", "अवस्था", "स्थिती"],
  "c.observed": ["Observed", "अवलोकित", "निरीक्षित"],
  "c.retrieved": ["Retrieved", "प्राप्त", "प्राप्त"],
  "c.source": ["Source", "स्रोत", "स्रोत"],
  "c.quality": ["Quality", "गुणवत्ता", "गुणवत्ता"],
  "c.provider": ["Provider", "प्रदाता", "प्रदाता"],
  "c.model": ["Model", "मॉडल", "मॉडेल"],
  "c.processing": ["Processing", "प्रसंस्करण", "प्रक्रिया"],
  "c.note": ["Note", "टिप्पणी", "टीप"],
  "c.description": ["Description", "विवरण", "वर्णन"],
  "c.provenance": ["Provenance", "उद्गम", "उगम"],
  "c.evidenceId": ["evidence_id", "evidence_id", "evidence_id"],
  "c.none": ["none", "कोई नहीं", "नाही"],
  "c.allDomains": ["All domains", "सभी क्षेत्र", "सर्व क्षेत्रे"],
  "c.allStates": ["All states", "सभी अवस्थाएँ", "सर्व स्थिती"],
  "c.reason": ["Reason", "कारण", "कारण"],
  "c.level": ["Level", "स्तर", "पातळी"],
  "c.status": ["Status", "स्थिति", "स्थिती"],
  "c.created": ["Created", "बनाया गया", "तयार केले"],
  "c.updated": ["Updated", "अद्यतनित", "अद्यतनित"],
  "c.detected": ["Detected", "पता चला", "आढळले"],
  "c.type": ["Type", "प्रकार", "प्रकार"],
  "c.loading": ["Loading…", "लोड हो रहा…", "लोड होत आहे…"],
  "c.run": ["Run", "चलाएँ", "चालवा"],
  "c.refresh": ["Refresh", "ताज़ा करें", "रीफ्रेश करा"],
  "c.close": ["Close", "बंद करें", "बंद करा"],
  "c.noData": ["No data", "कोई डेटा नहीं", "डेटा नाही"],
  "c.time": ["Time", "समय", "वेळ"],

  // ---------------------------------------------------------------- world
  "world.title": ["World model — {field}", "विश्व मॉडल — {field}", "वर्ल्ड मॉडेल — {field}"],
  "world.sub": [
    "The composed, versioned state of this field: every layer shows its truth state, its evidence count and why it is what it is.",
    "इस फ़ील्ड की संयोजित, संस्करणित अवस्था: हर परत अपनी सत्य अवस्था, साक्ष्य गणना और कारण दिखाती है।",
    "या प्लॉटची एकत्रित, आवृत्तीबद्ध स्थिती: प्रत्येक थर त्याची सत्य स्थिती, पुरावा संख्या आणि कारण दाखवतो.",
  ],
  "world.refresh": ["Refresh pipeline", "पाइपलाइन ताज़ा करें", "पाइपलाइन रीफ्रेश करा"],
  "world.refreshing": ["Refreshing…", "ताज़ा हो रहा…", "रीफ्रेश होत आहे…"],
  "world.analyze": ["Analyze field", "फ़ील्ड का विश्लेषण", "प्लॉटचे विश्लेषण"],
  "world.analyzing": ["Analyzing…", "विश्लेषण हो रहा…", "विश्लेषण होत आहे…"],
  "world.basemap": ["Basemap", "आधार नक्शा", "बेस नकाशा"],
  "world.layers": ["Layers", "परतें", "थर"],
  "world.acquisitions": ["Acquisitions", "अधिग्रहण", "संपादने"],
  "world.domainStates": ["Domain states", "क्षेत्र अवस्थाएँ", "क्षेत्र स्थिती"],
  "world.map": ["Spatial world", "स्थानिक विश्व", "स्थानिक जग"],
  "world.dark": ["Dark", "गहरा", "गडद"],
  "world.light": ["Light", "हल्का", "हलके"],
  "world.sat": ["Satellite", "उपग्रह", "उपग्रह"],

  // -------------------------------------------------------------- evidence
  "ev.title": ["Evidence — {field}", "साक्ष्य — {field}", "पुरावा — {field}"],
  "ev.sub": [
    "Every record carries an explicit truth state and full provenance. Model output is never presented as sensor observation; unavailable sources are labelled, not filled.",
    "हर रिकॉर्ड में स्पष्ट सत्य अवस्था और पूर्ण उद्गम होता है। मॉडल आउटपुट को कभी सेंसर अवलोकन के रूप में नहीं दिखाया जाता; अनुपलब्ध स्रोत लेबल किए जाते हैं, भरे नहीं जाते।",
    "प्रत्येक रेकॉर्डमध्ये स्पष्ट सत्य स्थिती आणि पूर्ण उगम असतो. मॉडेल आउटपुट कधीही सेन्सर निरीक्षण म्हणून दाखवले जात नाही; अनुपलब्ध स्रोत लेबल केले जातात, भरले जात नाहीत.",
  ],
  "ev.graph": ["Evidence graph", "साक्ष्य ग्राफ", "पुरावा आलेख"],
  "ev.graphSub": [
    "Real relationships between records: contradictions detected by the engines, evidence linked to investigations, and evidence cited by anomalies and risks.",
    "रिकॉर्ड्स के बीच वास्तविक संबंध: इंजनों द्वारा पहचाने गए विरोधाभास, जाँच से जुड़ा साक्ष्य, और विसंगतियों व जोखिमों द्वारा उद्धृत साक्ष्य।",
    "रेकॉर्ड्समधील वास्तविक संबंध: इंजिनांनी शोधलेले विरोधाभास, तपासणीशी जोडलेला पुरावा, आणि विसंगती व जोखीम यांनी उद्धृत केलेला पुरावा.",
  ],
  "ev.noTitle": ["No evidence in this view", "इस दृश्य में कोई साक्ष्य नहीं", "या दृश्यात पुरावा नाही"],
  "ev.noBody": [
    "The field has no evidence records yet. Run analysis or wait for the scheduled provider refresh.",
    "फ़ील्ड में अभी कोई साक्ष्य रिकॉर्ड नहीं है। विश्लेषण चलाएँ या अनुसूचित प्रदाता ताज़गी की प्रतीक्षा करें।",
    "प्लॉटमध्ये अजून पुरावा रेकॉर्ड नाही. विश्लेषण चालवा किंवा नियोजित प्रदाता रीफ्रेशची प्रतीक्षा करा.",
  ],
  "ev.tryDiff": ["Try a different domain or truth state.", "कोई भिन्न क्षेत्र या सत्य अवस्था चुनें।", "वेगळे क्षेत्र किंवा सत्य स्थिती निवडा."],
  "ev.graphEmpty": [
    "No cross-record relationships exist yet — they appear here as the contradiction engine and investigations link real evidence.",
    "अभी कोई अंतर-रिकॉर्ड संबंध नहीं है — जैसे ही विरोधाभास इंजन और जाँच वास्तविक साक्ष्य जोड़ेंगे, वे यहाँ दिखेंगे।",
    "अजून कोणतेही आंतर-रेकॉर्ड संबंध नाहीत — विरोधाभास इंजिन आणि तपासणी वास्तविक पुरावा जोडताच ते येथे दिसतील.",
  ],

  // ------------------------------------------------------------ intelligence
  "intel.title": ["Intelligence — {field}", "बुद्धिमत्ता — {field}", "बुद्धिमत्ता — {field}"],
  "intel.sub": [
    "Engine output over real evidence only: risks cite their evidence, anomalies name their trigger, uncertainty states what is missing, contradictions name both sides.",
    "केवल वास्तविक साक्ष्य पर इंजन आउटपुट: जोखिम अपने साक्ष्य का हवाला देते हैं, विसंगतियाँ अपना ट्रिगर बताती हैं, अनिश्चितता बताती है कि क्या कमी है, विरोधाभास दोनों पक्ष बताते हैं।",
    "फक्त वास्तविक पुराव्यावर इंजिन आउटपुट: जोखीम आपला पुरावा उद्धृत करतात, विसंगती आपला ट्रिगर सांगतात, अनिश्चितता काय गहाळ आहे ते सांगते, विरोधाभास दोन्ही बाजू सांगतो.",
  ],
  "intel.risks": ["Risks", "जोखिमें", "जोखीम"],
  "intel.anomalies": ["Anomalies", "विसंगतियाँ", "विसंगती"],
  "intel.uncertainty": ["Uncertainty", "अनिश्चितता", "अनिश्चितता"],
  "intel.contradictions": ["Contradictions", "विरोधाभास", "विरोधाभास"],
  "intel.investigations": ["Investigations", "जाँच", "तपासणी"],

  // -------------------------------------------------------------- satellite
  "sat.title": ["Satellite / Earth observation — {field}", "उपग्रह / पृथ्वी अवलोकन — {field}", "उपग्रह / पृथ्वी निरीक्षण — {field}"],
  "sat.sub": [
    "Real STAC discovery against provider catalogs. “Latest acquisition” means the newest product the provider actually has — not live imagery. Metadata is real; raster previews may require credentials.",
    "प्रदाता कैटलॉग के विरुद्ध वास्तविक STAC खोज। “नवीनतम अधिग्रहण” का अर्थ है प्रदाता के पास वास्तव में मौजूद सबसे नया उत्पाद — लाइव इमेजरी नहीं। मेटाडेटा वास्तविक है; रास्टर पूर्वावलोकन के लिए क्रेडेंशियल की आवश्यकता हो सकती है।",
    "प्रदाता कॅटलॉगविरुद्ध वास्तविक STAC शोध. “नवीनतम संपादन” म्हणजे प्रदात्याकडे खरोखर असलेले सर्वात नवीन उत्पाद — थेट प्रतिमा नाही. मेटाडेटा वास्तविक आहे; रास्टर पूर्वावलोकनासाठी क्रेडेन्शियल्स लागू शकतात.",
  ],
  "sat.checkProvider": ["🔎 Check provider", "🔎 प्रदाता जाँचें", "🔎 प्रदाता तपासा"],
  "sat.discover": ["Discover acquisitions", "अधिग्रहण खोजें", "संपादने शोधा"],
  "sat.total": ["Total products", "कुल उत्पाद", "एकूण उत्पादने"],
  "sat.provider": ["Provider", "प्रदाता", "प्रदाता"],
  "sat.latest": ["Latest acquisition", "नवीनतम अधिग्रहण", "नवीनतम संपादन"],
  "sat.best": ["Best qualified", "सर्वोत्तम योग्य", "सर्वोत्तम पात्र"],
  "sat.cloud": ["% cloud", "% बादल", "% ढग"],
  "sat.timeline": ["Acquisition timeline", "अधिग्रहण समयरेखा", "संपादन कालरेखा"],
  "sat.products": ["Products", "उत्पाद", "उत्पादने"],
  "sat.querying": ["Querying satellite catalog…", "उपग्रह कैटलॉग खोजा जा रहा…", "उपग्रह कॅटलॉग शोधत आहे…"],
  "sat.none": ["No acquisitions recorded for this field yet.", "इस फ़ील्ड के लिए अभी कोई अधिग्रहण दर्ज नहीं है।", "या प्लॉटसाठी अजून संपादन नोंदवलेले नाही."],

  // ---------------------------------------------------------------- sensors
  "sens.title": ["Sensors — {field}", "सेंसर — {field}", "सेन्सर — {field}"],
  "sens.sub": [
    "Physical device registry and telemetry. Observations are OBSERVED or absent (NO_DATA) — no telemetry is ever invented.",
    "भौतिक डिवाइस रजिस्ट्री और टेलीमेट्री। अवलोकन OBSERVED या अनुपस्थित (NO_DATA) हैं — टेलीमेट्री कभी काल्पनिक नहीं होती।",
    "भौतिक डिव्हाइस नोंदणी आणि टेलिमेट्री. निरीक्षणे OBSERVED किंवा अनुपस्थित (NO_DATA) आहेत — टेलिमेट्री कधीही काल्पनिक नाही.",
  ],
  "sens.devices": ["Devices", "डिवाइस", "डिव्हाइसेस"],
  "sens.observations": ["Observations", "अवलोकन", "निरीक्षणे"],
  "sens.register": ["Register device", "डिवाइस पंजीकृत करें", "डिव्हाइस नोंदणी करा"],
  "sens.chart": ["Series", "श्रृंखला", "मालिका"],

  // ----------------------------------------------------------------- system
  "sys.title": ["System", "सिस्टम", "प्रणाली"],
  "sys.sub": [
    "Continuous monitoring worker, provider health and the live event bus. Provider failures are recorded with explicit states — a failed provider never looks healthy.",
    "सतत निगरानी वर्कर, प्रदाता स्वास्थ्य और लाइव इवेंट बस। प्रदाता विफलताएँ स्पष्ट अवस्थाओं के साथ दर्ज होती हैं — एक असफल प्रदाता कभी स्वस्थ नहीं दिखता।",
    "सतत निरीक्षण वर्कर, प्रदाता आरोग्य आणि थेट इव्हेंट बस. प्रदाता अपयश स्पष्ट स्थितींसह नोंदवले जातात — अपयशी प्रदाता कधीही निरोगी दिसत नाही.",
  ],
  "sys.runChecks": ["🔎 Run provider checks", "🔎 प्रदाता जाँच चलाएँ", "🔎 प्रदाता तपासणी चालवा"],
  "sys.service": ["Service", "सेवा", "सेवा"],
  "sys.worker": ["Worker cadence", "वर्कर गति", "वर्कर गती"],
  "sys.events": ["Events stream", "इवेंट स्ट्रीम", "इव्हेंट स्ट्रीम"],
  "sys.db": ["DB", "डीबी", "डीबी"],
  "sys.providerHealth": ["Provider health", "प्रदाता स्वास्थ्य", "प्रदाता आरोग्य"],
  "sys.jobs": ["Jobs", "कार्य", "नोकऱ्या"],
  "sys.eventBus": ["Event bus", "इवेंट बस", "इव्हेंट बस"],
  "sys.active": ["active", "सक्रिय", "सक्रिय"],
  "sys.ok": ["ok", "ठीक", "ठीक"],

  // ----------------------------------------------------------- farms/fields
  "fields.title": ["Farms & fields", "खेत और फ़ील्ड", "शेत आणि प्लॉट"],
  "fields.sub": [
    "Create farms, draw field boundaries on the map or paste GeoJSON. Geometry is validated server-side; the development seed is explicitly labelled.",
    "खेत बनाएँ, नक्शे पर फ़ील्ड सीमाएँ बनाएँ या GeoJSON पेस्ट करें। ज्यामिति सर्वर-साइड सत्यापित होती है; विकास सीड स्पष्ट रूप से लेबल किया जाता है।",
    "शेत तयार करा, नकाशावर प्लॉट सीमा काढा किंवा GeoJSON पेस्ट करा. भूमिती सर्व्हर-साइड सत्यापित होते; विकास सीड स्पष्टपणे लेबल केली जाते.",
  ],
  "fields.createFarm": ["Create farm", "खेत बनाएँ", "शेत तयार करा"],
  "fields.createField": ["Create field", "फ़ील्ड बनाएँ", "प्लॉट तयार करा"],
  "fields.draw": ["Draw on map", "नक्शे पर बनाएँ", "नकाशावर काढा"],
  "fields.paste": ["Paste GeoJSON", "GeoJSON पेस्ट करें", "GeoJSON पेस्ट करा"],
  "fields.seed": ["Load development seed", "विकास सीड लोड करें", "विकास सीड लोड करा"],
  "fields.save": ["Save", "सहेजें", "जतन करा"],

  // ------------------------------------------------------------------- twin
  "twin.title": ["Digital Twin — {field}", "डिजिटल ट्विन — {field}", "डिजिटल ट्विन — {field}"],
  "twin.sub": [
    "A 3D spatial view of the same world model. Every rendered layer carries its truth label — nothing is drawn that has no real evidence behind it.",
    "उसी विश्व मॉडल का 3D स्थानिक दृश्य। हर प्रस्तुत परत अपना सत्य लेबल रखती है — बिना वास्तविक साक्ष्य के कुछ भी नहीं बनाया जाता।",
    "त्याच वर्ल्ड मॉडेलचे 3D स्थानिक दृश्य. प्रत्येक प्रस्तुत थर आपले सत्य लेबल ठेवतो — वास्तविक पुराव्याशिवाय काहीही काढले जात नाही.",
  ],
  "twin.explode": ["Explode", "अलग करें", "वेगळे करा"],
  "twin.orbit": ["Orbit", "परिक्रमा", "प्रदक्षिणा"],
  "twin.layers": ["Layers", "परतें", "थर"],
  "twin.legend": ["Truth legend", "सत्य लेजेंड", "सत्य लेजंड"],

  // ------------------------------------------------------------- simulation
  "sim.title": ["Simulation — {field}", "सिमुलेशन — {field}", "सिम्युलेशन — {field}"],
  "sim.sub": [
    "Deterministic water-balance scenarios. Output is SIMULATED and kept separate from observed evidence — never presented as measurement.",
    "नियतात्मक जल-संतुलन परिदृश्य। आउटपुट SIMULATED है और अवलोकित साक्ष्य से अलग रखा जाता है — कभी माप के रूप में नहीं दिखाया जाता।",
    "निर्धारक पाणी-शिल्लक परिदृश्ये. आउटपुट SIMULATED आहे आणि निरीक्षित पुराव्यापासून वेगळे ठेवले जाते — कधीही माप म्हणून दाखवले जात नाही.",
  ],
  "sim.newScenario": ["New scenario", "नया परिदृश्य", "नवीन परिदृश्य"],
  "sim.run": ["Run simulation", "सिमुलेशन चलाएँ", "सिम्युलेशन चालवा"],
  "sim.results": ["Results (SIMULATED)", "परिणाम (SIMULATED)", "निकाल (SIMULATED)"],

  // -------------------------------------------------------- notes & memory
  "notes.title": ["Notes & memory — {field}", "नोट्स और स्मृति — {field}", "नोट्स आणि स्मृती — {field}"],
  "notes.sub": [
    "Farmer observations enter the evidence stack as OBSERVED farmer input; farm memory records real changes only.",
    "किसान अवलोकन साक्ष्य स्टैक में OBSERVED किसान इनपुट के रूप में प्रवेश करते हैं; फ़ार्म स्मृति केवल वास्तविक परिवर्तन दर्ज करती है।",
    "शेतकरी निरीक्षणे पुरावा स्टॅकमध्ये OBSERVED शेतकरी इनपुट म्हणून प्रवेश करतात; शेती स्मृती फक्त वास्तविक बदल नोंदवते.",
  ],
  "notes.farmerObs": ["Farmer observations", "किसान अवलोकन", "शेतकरी निरीक्षणे"],
  "notes.memory": ["Farm memory", "फ़ार्म स्मृति", "शेती स्मृती"],
  "notes.add": ["Add observation", "अवलोकन जोड़ें", "निरीक्षण जोडा"],
  "notes.verify": ["Verify", "सत्यापित करें", "सत्यापित करा"],

  // ---------------------------------------------------------------- history
  "hist.title": ["History — {field}", "इतिहास — {field}", "इतिहास — {field}"],
  "hist.sub": [
    "Versioned world model snapshots, the field-scoped event log, and farm memory — the record of what actually changed and when.",
    "संस्करणित विश्व मॉडल स्नैपशॉट, फ़ील्ड-स्कोप्ड इवेंट लॉग और फ़ार्म स्मृति — क्या और कब बदला इसका रिकॉर्ड।",
    "आवृत्तीबद्ध वर्ल्ड मॉडेल स्नॅपशॉट्स, प्लॉट-स्कोप्ड इव्हेंट लॉग आणि शेती स्मृती — काय आणि कधी बदलले याचा रेकॉर्ड.",
  ],
  "hist.versions": ["World model versions", "विश्व मॉडल संस्करण", "वर्ल्ड मॉडेल आवृत्त्या"],
  "hist.events": ["Event log", "इवेंट लॉग", "इव्हेंट लॉग"],
  "hist.memory": ["Farm memory", "फ़ार्म स्मृति", "शेती स्मृती"],

  // ---------------------------------------------------------- investigations
  "inv.title": ["Investigations — {field}", "जाँच — {field}", "तपासणी — {field}"],
  "inv.sub": [
    "Open an investigation from a real trigger, collect evidence, form hypotheses and rank the next best observation.",
    "किसी वास्तविक ट्रिगर से जाँच खोलें, साक्ष्य एकत्र करें, परिकल्पनाएँ बनाएँ और अगला सर्वोत्तम अवलोकन चुनें।",
    "वास्तविक ट्रिगरवरून तपासणी उघडा, पुरावा गोळा करा, गृहीतके तयार करा आणि पुढील सर्वोत्तम निरीक्षण निवडा.",
  ],
  "inv.trigger": ["Open investigation", "जाँच खोलें", "तपासणी उघडा"],
  "inv.hypotheses": ["Hypotheses", "परिकल्पनाएँ", "गृहीतके"],
  "inv.nextObs": ["Next best observations", "अगले सर्वोत्तम अवलोकन", "पुढील सर्वोत्तम निरीक्षणे"],

  // -------------------------------------------------------------- assistant
  "asst.title": ["AI assistant", "AI सहायक", "AI सहाय्यक"],
  "asst.sub": [
    "Field-scoped answers grounded in real evidence. Without an LLM key the assistant answers in an explicit LOCAL_GROUNDED_FALLBACK mode and never invents values.",
    "वास्तविक साक्ष्य पर आधारित फ़ील्ड-स्कोप्ड उत्तर। LLM कुंजी के बिना सहायक स्पष्ट LOCAL_GROUNDED_FALLBACK मोड में उत्तर देता है और कभी मान नहीं बनाता।",
    "वास्तविक पुराव्यावर आधारित प्लॉट-स्कोप्ड उत्तर. LLM कीशिवाय सहाय्यक स्पष्ट LOCAL_GROUNDED_FALLBACK मोडमध्ये उत्तर देतो आणि कधीही मूल्ये शोधून काढत नाही.",
  ],
  "asst.newSession": ["New session", "नया सत्र", "नवीन सत्र"],
  "asst.placeholder": ["Ask about this field…", "इस फ़ील्ड के बारे में पूछें…", "या प्लॉटबद्दल विचारा…"],
  "asst.send": ["Send", "भेजें", "पाठवा"],
  "asst.mode": ["Mode", "मोड", "मोड"],

  // ------------------------------------------------------- layer workspaces
  "layer.providerHealth": ["Provider health", "प्रदाता स्वास्थ्य", "प्रदाता आरोग्य"],
  "layer.wmState": ["World model layer state", "विश्व मॉडल परत अवस्था", "वर्ल्ड मॉडेल थर स्थिती"],
  "layer.latest": ["Latest per variable", "प्रति चर नवीनतम", "प्रति चल नवीनतम"],
  "layer.evidence": ["Evidence table", "साक्ष्य तालिका", "पुरावा सारणी"],
  "layer.weather": ["Weather — {field}", "मौसम — {field}", "हवामान — {field}"],
  "layer.water": ["Water — {field}", "जल — {field}", "पाणी — {field}"],
  "layer.soil": ["Soil — {field}", "मिट्टी — {field}", "माती — {field}"],
  "layer.terrain": ["Terrain — {field}", "भू-आकृति — {field}", "भूप्रदेश — {field}"],
  "layer.crop": ["Crop — {field}", "फ़सल — {field}", "पीक — {field}"],
  "layer.weatherSub": [
    "Model output from Open-Meteo. Nowcast is DERIVED, history is HISTORICAL, forecasts are PREDICTED — reanalysis is never presented as a physical sensor reading.",
    "Open-Meteo से मॉडल आउटपुट। नाउकास्ट DERIVED है, इतिहास HISTORICAL है, पूर्वानुमान PREDICTED हैं — रीएनालिसिस कभी भौतिक सेंसर रीडिंग के रूप में नहीं दिखाया जाता।",
    "Open-Meteo कडून मॉडेल आउटपुट. नाउकास्ट DERIVED आहे, इतिहास HISTORICAL आहे, अंदाज PREDICTED आहेत — रीअॅनालिसिस कधीही भौतिक सेन्सर वाचन म्हणून दाखवले जात नाही.",
  ],
  "layer.waterSub": [
    "Surface water, irrigation and groundwater context. Without a configured national source the layer reports NOT_CONFIGURED — no depth is invented.",
    "सतही जल, सिंचाई और भूजल संदर्भ। राष्ट्रीय स्रोत कॉन्फ़िगर न होने पर परत NOT_CONFIGURED बताती है — कोई गहराई नहीं बनाई जाती।",
    "पृष्ठभाग पाणी, सिंचन आणि भूजल संदर्भ. राष्ट्रीय स्रोत कॉन्फिगर नसल्यास थर NOT_CONFIGURED सांगतो — कोणतीही खोली शोधली जात नाही.",
  ],
  "layer.soilSub": [
    "Soil property model estimates with depth, source and provenance. ISRIC paused SoilGrids — the outage is reported as DATA_QUALITY_FAILURE, not filled with guesses.",
    "गहराई, स्रोत और उद्गम के साथ मिट्टी गुण मॉडल अनुमान। ISRIC ने SoilGrids रोक दिया — यह आउटेज DATA_QUALITY_FAILURE के रूप में दिखाया जाता है, अनुमान से नहीं भरा जाता।",
    "खोली, स्रोत आणि उगमासह माती गुणधर्म मॉडेल अंदाज. ISRIC ने SoilGrids थांबवले — हे अपयश DATA_QUALITY_FAILURE म्हणून दाखवले जाते, अंदाजाने भरले जात नाही.",
  ],
  "layer.terrainSub": [
    "DEM-derived elevation at the field centroid. Only a single point is available, so slope and aspect remain UNKNOWN — the surface is never fabricated.",
    "फ़ील्ड केंद्र पर DEM-व्युत्पन्न ऊँचाई। केवल एक बिंदु उपलब्ध है, इसलिए ढलान और दिशा UNKNOWN रहती हैं — सतह कभी काल्पनिक नहीं होती।",
    "प्लॉट केंद्रस्थानी DEM-व्युत्पन्न उंची. फक्त एक बिंदू उपलब्ध आहे, म्हणून उतार आणि दिशा UNKNOWN राहतात — पृष्ठभाग कधीही काल्पनिक नाही.",
  ],
  "layer.cropSub": [
    "Declared crop metadata for the field. Growth/stress indicators are only shown when real evidence supports them.",
    "फ़ील्ड के लिए घोषित फ़सल मेटाडेटा। वृद्धि/तनाव संकेतक केवल तभी दिखाए जाते हैं जब वास्तविक साक्ष्य उन्हें समर्थन देते हैं।",
    "प्लॉटसाठी घोषित पीक मेटाडेटा. वाढ/ताण निर्देशक फक्त तेव्हाच दाखवले जातात जेव्हा वास्तविक पुरावा त्यांना समर्थन देतो.",
  ],

  // ------------------------------------------------------- world page extras
  "world.checkAcq": ["Check acquisitions", "अधिग्रहण जाँचें", "संपादने तपासा"],
  "world.legendField": ["Field boundary", "फ़ील्ड सीमा", "प्लॉट सीमा"],
  "world.legendCentroid": ["Centroid", "केंद्र", "केंद्रबिंदू"],
  "world.legendAcq": ["Acquisitions ({n})", "अधिग्रहण ({n})", "संपादने ({n})"],
  "world.satNote": [
    "Satellite basemap is a generic basemap — not field-specific imagery.",
    "उपग्रह आधार नक्शा सामान्य है — फ़ील्ड-विशिष्ट इमेजरी नहीं।",
    "उपग्रह बेस नकाशा सामान्य आहे — प्लॉट-विशिष्ट प्रतिमा नाही.",
  ],
  "world.acqTitle": ["Satellite acquisitions ({n})", "उपग्रह अधिग्रहण ({n})", "उपग्रह संपादने ({n})"],
  "world.acquired": ["Acquired", "प्राप्त", "प्राप्त"],
  "world.cloud": ["Cloud", "बादल", "ढग"],
  "world.res": ["Res.", "रिज़ॉ.", "रिझ."],
  "world.product": ["Product", "उत्पाद", "उत्पाद"],
  "world.notComposedTitle": ["World model not composed yet", "विश्व मॉडल अभी बना नहीं है", "वर्ल्ड मॉडेल अजून तयार झाले नाही"],
  "world.notComposedBody": [
    "Run analysis or wait for the scheduled worker to compose the first snapshot from real provider evidence.",
    "विश्लेषण चलाएँ या अनुसूचित वर्कर के पहले स्नैपशॉट बनाने की प्रतीक्षा करें।",
    "विश्लेषण चालवा किंवा नियोजित वर्करने पहिला स्नॅपशॉट तयार करण्याची प्रतीक्षा करा.",
  ],
  "world.composeNow": ["Compose now", "अभी बनाएँ", "आता तयार करा"],
  "world.fieldSnapshot": ["Field snapshot", "फ़ील्ड स्नैपशॉट", "प्लॉट स्नॅपशॉट"],
  "world.area": ["Area", "क्षेत्रफल", "क्षेत्रफळ"],
  "world.evidenceRecords": ["Evidence records", "साक्ष्य रिकॉर्ड", "पुरावा रेकॉर्ड"],
  "world.devices": ["Devices", "डिवाइस", "डिव्हाइसेस"],
  "world.registered": ["registered hardware", "पंजीकृत हार्डवेयर", "नोंदणीकृत हार्डवेअर"],
  "world.noneReg": ["none registered", "कोई पंजीकृत नहीं", "कोणतेही नोंदणीकृत नाही"],
  "world.latestAt": ["latest {t}", "नवीनतम {t}", "नवीनतम {t}"],
  "world.records": ["{n} records", "{n} रिकॉर्ड", "{n} रेकॉर्ड"],
  "world.composing": ["Composing world model…", "विश्व मॉडल बन रहा…", "वर्ल्ड मॉडेल तयार होत आहे…"],

  // --------------------------------------------------------- satellite table
  "sat.satellite": ["Satellite", "उपग्रह", "उपग्रह"],
  "sat.productId": ["Product ID", "उत्पाद ID", "उत्पाद ID"],
  "sat.collection": ["Collection", "संग्रह", "संग्रह"],
  "sat.cloudCol": ["Cloud", "बादल", "ढग"],
  "sat.resCol": ["Resolution", "रिज़ॉल्यूशन", "रिझोल्यूशन"],
  "sat.level": ["Level", "स्तर", "पातळी"],
  "sat.statusCol": ["Status", "स्थिति", "स्थिती"],
  "sat.assets": ["Assets", "एसेट", "अॅसेट्स"],
  "sat.preview": ["Preview", "पूर्वावलोकन", "पूर्वावलोकन"],
  "sat.metadata": ["Metadata", "मेटाडेटा", "मेटाडेटा"],

  // ----------------------------------------------------------- system table
  "sys.lastCheck": ["Last check", "अंतिम जाँच", "शेवटची तपासणी"],
  "sys.lastSuccess": ["Last success", "अंतिम सफलता", "शेवटचे यश"],
  "sys.lastError": ["Last error", "अंतिम त्रुटि", "शेवटची त्रुटी"],
  "sys.latency": ["Latency", "विलंब", "विलंब"],
  "sys.jobType": ["Job type", "कार्य प्रकार", "नोकरी प्रकार"],
  "sys.finished": ["Finished", "समाप्त", "पूर्ण"],
  "sys.jobsEmpty": ["No jobs recorded yet — the worker writes a record on every run.", "अभी कोई कार्य दर्ज नहीं — वर्कर हर बार चलने पर रिकॉर्ड लिखता है।", "अजून नोकरी नोंदवलेली नाही — वर्कर प्रत्येक वेळी रेकॉर्ड लिहितो."],
  "sys.providersEmpty": ["No provider states recorded yet.", "अभी कोई प्रदाता स्थिति दर्ज नहीं।", "अजून प्रदाता स्थिती नोंदवलेली नाही."],

  // -------------------------------------------------------------- sensors
  "sens.device": ["Device", "डिवाइस", "डिव्हाइस"],
  "sens.kind": ["Kind", "प्रकार", "प्रकार"],
  "sens.firmware": ["Firmware", "फ़र्मवेयर", "फर्मवेअर"],
  "sens.lastSeen": ["Last seen", "अंतिम बार", "शेवटचे दिसले"],
  "sens.regSub": ["Register a device to receive telemetry. No device is ever shown as online unless it heartbeats.", "टेलीमेट्री पाने के लिए डिवाइस पंजीकृत करें। जब तक डिवाइस हार्टबीट नहीं देता, उसे कभी ऑनलाइन नहीं दिखाया जाता।", "टेलिमेट्री मिळवण्यासाठी डिव्हाइस नोंदणी करा. डिव्हाइस हार्टबीट देत नाही तोपर्यंत ते कधीही ऑनलाइन दाखवले जात नाही."],
  "sens.obsEmpty": ["No telemetry yet — observations appear here the moment a gateway posts real data.", "अभी कोई टेलीमेट्री नहीं — गेटवे वास्तविक डेटा भेजते ही अवलोकन यहाँ दिखेंगे।", "अजून टेलिमेट्री नाही — गेटवे वास्तविक डेटा पाठवताच निरीक्षणे येथे दिसतील."],
  "sens.empty": ["No devices registered for this field yet.", "इस फ़ील्ड के लिए अभी कोई डिवाइस पंजीकृत नहीं।", "या प्लॉटसाठी अजून डिव्हाइस नोंदणीकृत नाहीत."],

  // ----------------------------------------------------------------- twin
  "twin.terrain": ["Terrain", "भू-आकृति", "भूप्रदेश"],
  "twin.soil": ["Soil", "मिट्टी", "माती"],
  "twin.crops": ["Crops", "फ़सलें", "पिके"],
  "twin.sensors": ["Sensors", "सेंसर", "सेन्सर"],
  "twin.satellite": ["Satellite", "उपग्रह", "उपग्रह"],
  "twin.intel": ["Intelligence", "बुद्धिमत्ता", "बुद्धिमत्ता"],
  "twin.ground": ["Ground", "ज़मीन", "जमीन"],

  // -------------------------------------------------------------- simulation
  "sim.name": ["Scenario name", "परिदृश्य नाम", "परिदृश्य नाव"],
  "sim.waterApplied": ["Water applied / day (mm)", "प्रति दिन पानी (मिमी)", "दररोज पाणी (मिमी)"],
  "sim.assumptions": ["Assumptions", "मान्यताएँ", "गृहीतके"],
  "sim.limitations": ["Limitations", "सीमाएँ", "मर्यादा"],

  // ------------------------------------------------------------- history
  "hist.snapshot": ["Snapshot", "स्नैपशॉट", "स्नॅपशॉट"],
  "hist.trigger": ["Trigger", "ट्रिगर", "ट्रिगर"],
  "hist.at": ["At", "समय", "वेळ"],

  // -------------------------------------------------------- investigations
  "inv.problem": ["Problem / trigger", "समस्या / ट्रिगर", "समस्या / ट्रिगर"],
  "inv.evidence": ["Linked evidence", "जुड़ा साक्ष्य", "जोडलेला पुरावा"],
  "inv.conclusion": ["Conclusion", "निष्कर्ष", "निष्कर्ष"],

  // ------------------------------------------------------------ assistant
  "asst.sessions": ["Sessions", "सत्र", "सत्रे"],
  "asst.answerMode": ["Answer mode", "उत्तर मोड", "उत्तर मोड"],
  "asst.uncertainty": ["Uncertainty", "अनिश्चितता", "अनिश्चितता"],

  // ------------------------------------------------------------- evidence
  "ev.provPanel": ["Provenance", "उद्गम", "उगम"],
  "ev.descPanel": ["Description", "विवरण", "वर्णन"],
  "ev.retrievedAgo": ["retrieved {t}", "प्राप्त {t}", "प्राप्त {t}"],
  "ev.textNa": ["text / n/a", "पाठ / उपलब्ध नहीं", "मजकूर / उपलब्ध नाही"],
};

const LANG_INDEX: Record<Lang, number> = { en: 0, hi: 1, mr: 2 };

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx>({
  lang: "en",
  setLang: () => undefined,
  t: (k) => k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const saved = localStorage.getItem("agrifur_lang");
      if (saved === "hi" || saved === "mr" || saved === "en") return saved;
    } catch {
      /* ignore */
    }
    return "en";
  });

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("agrifur_lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const value = useMemo<I18nCtx>(() => {
    const t = (key: string, vars?: Record<string, string | number>): string => {
      const entry = DICT[key];
      // entry is a tuple [en, hi, mr]; index by language position.
      let out = entry ? entry[LANG_INDEX[lang]] : key;
      if (!entry) {
        // fall back: try English if the language entry is missing
        const en = DICT[key];
        out = en ? en[0] : key;
      }
      if (vars) {
        for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
      }
      return out;
    };
    return { lang, setLang: setLangState, t };
  }, [lang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  return useContext(Ctx);
}

/** Compact language switcher for the top bar / landing header. */
export function LangSwitch({ compact }: { compact?: boolean }) {
  const { lang, setLang, t } = useI18n();
  const opts: { id: Lang; label: string }[] = [
    { id: "en", label: t("lang.en") },
    { id: "hi", label: t("lang.hi") },
    { id: "mr", label: t("lang.mr") },
  ];
  return (
    <div className="row" style={{ gap: 4 }} title={t("lang.label")}>
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`lang-chip ${lang === o.id ? "active" : ""}`}
          onClick={() => setLang(o.id)}
          aria-pressed={lang === o.id}
          style={{
            fontSize: compact ? 11.5 : 12,
            padding: "3px 8px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: lang === o.id ? "var(--accent)" : "transparent",
            color: lang === o.id ? "#04130a" : "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}