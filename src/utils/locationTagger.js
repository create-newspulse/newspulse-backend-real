function _escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _normalizeForSearch(text) {
  // Normalize to a stable unicode form then lowercase.
  let s = String(text || '');
  try {
    s = s.normalize('NFKC');
  } catch (_) {
    // ignore if not supported
  }
  s = s.toLowerCase();

  // Replace common dash variants with a normal hyphen.
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-');

  // Replace punctuation/symbols with spaces so word-boundary matching works better.
  // Keep letters + numbers from all scripts.
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function _isLatinLike(s) {
  return /^[a-z0-9\-\s]+$/.test(s);
}

function _containsAlias(haystackNorm, aliasNorm) {
  if (!aliasNorm) return false;
  if (!haystackNorm) return false;

  if (_isLatinLike(aliasNorm)) {
    const escaped = _escapeRegex(aliasNorm);
    // Latin-ish boundary: avoid matching inside words.
    const rx = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    return rx.test(haystackNorm);
  }

  // For non-latin scripts (HI/GU), a simple substring check is usually sufficient.
  return haystackNorm.includes(aliasNorm);
}

// 28 States + 8 Union Territories (India)
// Aliases include English + Hindi + Gujarati (plus a few common English variants).
const INDIA_STATES_UTS = [
  { slug: 'andhra-pradesh', display: 'Andhra Pradesh', aliases: ['Andhra Pradesh', 'आंध्र प्रदेश', 'આંધ્ર પ્રદેશ'] },
  { slug: 'arunachal-pradesh', display: 'Arunachal Pradesh', aliases: ['Arunachal Pradesh', 'अरुणाचल प्रदेश', 'અરુણાચલ પ્રદેશ'] },
  { slug: 'assam', display: 'Assam', aliases: ['Assam', 'Asom', 'असम', 'આસામ'] },
  { slug: 'bihar', display: 'Bihar', aliases: ['Bihar', 'बिहार', 'બિહાર'] },
  { slug: 'chhattisgarh', display: 'Chhattisgarh', aliases: ['Chhattisgarh', 'छत्तीसगढ़', 'छत्तीसगढ़', 'છત્તીસગઢ', 'છત્તીસગઢ'] },
  { slug: 'goa', display: 'Goa', aliases: ['Goa', 'गोवा', 'ગોવા'] },
  { slug: 'gujarat', display: 'Gujarat', aliases: ['Gujarat', 'ગુજરાત', 'गुजरात'] },
  { slug: 'haryana', display: 'Haryana', aliases: ['Haryana', 'हरियाणा', 'હરિયાણા'] },
  { slug: 'himachal-pradesh', display: 'Himachal Pradesh', aliases: ['Himachal Pradesh', 'हिमाचल प्रदेश', 'હિમાચલ પ્રદેશ'] },
  { slug: 'jharkhand', display: 'Jharkhand', aliases: ['Jharkhand', 'झारखंड', 'ઝારખંડ'] },
  { slug: 'karnataka', display: 'Karnataka', aliases: ['Karnataka', 'कर्नाटक', 'કર્ણાટક'] },
  { slug: 'kerala', display: 'Kerala', aliases: ['Kerala', 'केरल', 'કેરળ'] },
  { slug: 'madhya-pradesh', display: 'Madhya Pradesh', aliases: ['Madhya Pradesh', 'मध्य प्रदेश', 'મધ્ય પ્રદેશ'] },
  { slug: 'maharashtra', display: 'Maharashtra', aliases: ['Maharashtra', 'महाराष्ट्र', 'મહારાષ્ટ્ર'] },
  { slug: 'manipur', display: 'Manipur', aliases: ['Manipur', 'मणिपुर', 'મણિપુર'] },
  { slug: 'meghalaya', display: 'Meghalaya', aliases: ['Meghalaya', 'मेघालय', 'મેઘાલય'] },
  { slug: 'mizoram', display: 'Mizoram', aliases: ['Mizoram', 'मिजोरम', 'મિઝોરમ'] },
  { slug: 'nagaland', display: 'Nagaland', aliases: ['Nagaland', 'नागालैंड', 'નાગાલેન્ડ'] },
  { slug: 'odisha', display: 'Odisha', aliases: ['Odisha', 'Orissa', 'ओडिशा', 'ઓડિશા'] },
  { slug: 'punjab', display: 'Punjab', aliases: ['Punjab', 'पंजाब', 'ਪੰਜਾਬ', 'પંજાબ'] },
  { slug: 'rajasthan', display: 'Rajasthan', aliases: ['Rajasthan', 'राजस्थान', 'રાજસ્થાન'] },
  { slug: 'sikkim', display: 'Sikkim', aliases: ['Sikkim', 'सिक्किम', 'સિક્કિમ'] },
  { slug: 'tamil-nadu', display: 'Tamil Nadu', aliases: ['Tamil Nadu', 'Tamilnadu', 'तमिलनाडु', 'तमिल नाडु', 'તમિલ નાડુ'] },
  { slug: 'telangana', display: 'Telangana', aliases: ['Telangana', 'तेलंगाना', 'તેલંગાણા'] },
  { slug: 'tripura', display: 'Tripura', aliases: ['Tripura', 'त्रिपुरा', 'ત્રિપુરા'] },
  { slug: 'uttar-pradesh', display: 'Uttar Pradesh', aliases: ['Uttar Pradesh', 'उत्तर प्रदेश', 'ઉત્તર પ્રદેશ'] },
  { slug: 'uttarakhand', display: 'Uttarakhand', aliases: ['Uttarakhand', 'Uttaranchal', 'उत्तराखंड', 'उत्तराखण्ड', 'ઉત્તરાખંડ'] },
  { slug: 'west-bengal', display: 'West Bengal', aliases: ['West Bengal', 'पश्चिम बंगाल', 'পশ্চিমবঙ্গ', 'પશ્ચિમ બંગાળ'] },

  // Union Territories
  {
    slug: 'andaman-and-nicobar-islands',
    display: 'Andaman and Nicobar Islands',
    aliases: [
      'Andaman and Nicobar',
      'Andaman and Nicobar Islands',
      'अंडमान और निकोबार',
      'अंडमान और निकोबार द्वीपसमूह',
      'અંડમાન અને નિકોબાર',
      'અંડમાન અને નિકોબાર દ્વીપસમૂહ',
    ],
  },
  { slug: 'chandigarh', display: 'Chandigarh', aliases: ['Chandigarh', 'चंडीगढ़', 'ਚੰਡੀਗੜ੍ਹ', 'ચંદીગઢ'] },
  {
    slug: 'dadra-and-nagar-haveli-and-daman-and-diu',
    display: 'Dadra and Nagar Haveli and Daman and Diu',
    aliases: [
      'Dadra and Nagar Haveli',
      'Daman and Diu',
      'Dadra and Nagar Haveli and Daman and Diu',
      'दादरा और नगर हवेली',
      'दमन और दीव',
      'दादरा और नगर हवेली और दमन और दीव',
      'દાદરા અને નગર હવેલી',
      'દમણ અને દીવ',
      'દાદરા અને નગર હવેલી અને દમણ અને દીવ',
    ],
  },
  { slug: 'delhi', display: 'Delhi', aliases: ['Delhi', 'New Delhi', 'NCT Delhi', 'दिल्ली', 'नई दिल्ली', 'નવી દિલ્હી', 'દિલ્હી'] },
  {
    slug: 'jammu-and-kashmir',
    display: 'Jammu and Kashmir',
    aliases: [
      'Jammu and Kashmir',
      'Jammu & Kashmir',
      'Jammu Kashmir',
      'जम्मू और कश्मीर',
      'जम्मू कश्मीर',
      'જમ્મુ અને કાશ્મીર',
      'જમ્મુ કાશ્મીર',
    ],
  },
  { slug: 'ladakh', display: 'Ladakh', aliases: ['Ladakh', 'लद्दाख', 'લદ્દાખ'] },
  { slug: 'lakshadweep', display: 'Lakshadweep', aliases: ['Lakshadweep', 'लक्षद्वीप', 'લક્ષદ્વીપ'] },
  { slug: 'puducherry', display: 'Puducherry', aliases: ['Puducherry', 'Pondicherry', 'पुदुचेरी', 'પુડુચેરી'] },

];

const VALID_STATE_SLUGS = new Set(INDIA_STATES_UTS.map(s => s.slug));

function isValidStateSlug(stateSlug) {
  const s = String(stateSlug || '').trim().toLowerCase();
  return VALID_STATE_SLUGS.has(s);
}

function tagStatesFromText(text) {
  const haystackNorm = _normalizeForSearch(text);
  const stateTags = [];
  const stateNames = [];
  const seen = new Set();

  for (const state of INDIA_STATES_UTS) {
    const aliases = Array.isArray(state.aliases) ? state.aliases : [];
    let matched = false;
    for (const alias of aliases) {
      const aliasNorm = _normalizeForSearch(alias);
      if (!aliasNorm) continue;
      if (_containsAlias(haystackNorm, aliasNorm)) {
        matched = true;
        break;
      }
    }

    if (matched && !seen.has(state.slug)) {
      seen.add(state.slug);
      stateTags.push(state.slug);
      stateNames.push(state.display);
    }
  }

  return { stateTags, stateNames };
}

module.exports = {
  INDIA_STATES_UTS,
  VALID_STATE_SLUGS,
  isValidStateSlug,
  tagStatesFromText,
};
