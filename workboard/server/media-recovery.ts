import {HttpError} from "./http";
import {OPERATOR_MEDIA_ROUNDS} from "../shared/media-policy";
export {OPERATOR_MEDIA_ROUNDS};
export class ImageCandidatesRejected extends HttpError {
 constructor(public slot:number,public reasons:string[]){super(409,"MEDIA_REVIEW: 새 이미지 후보 2개가 적합성 검토에서 반려됐습니다.");}
}
/** One new, bounded batch after confirmed visual rejection. Unknown requests never enter here. */
export function planMediaRecovery(payload:any,error:unknown){
 if(!(error instanceof ImageCandidatesRejected)||payload.photo_retry_revision)return false;
 payload.photo_retry_revision=4;
 payload.media_recovery={state:"retrying",attempt:1,slot:error.slot,reasons:error.reasons.slice(0,2),at:new Date().toISOString()};
 delete payload.recovery;
 return true;
}
/** Topics whose subject is itself transport; their images must keep the vehicles. */
export const TRANSPORT_TOPIC=/\b(?:subways?|metro|buses|bus|taxis?|transit|transport(?:ation)?|trains?|commut\w*)\b/i;
const STREET_TOPIC=/\b(?:walks?|walking|neighbou?rhoods?|streets?|alleys?|districts?|markets?|villages?|hanok)\b/i;
/** Real settings covered in shop signs, menus and neon. A wide generated view of them always contains lettering. */
export const SIGNAGE_SCENE=/\b(?:alleys?|markets?|streets?|restaurants?|food|eateries|bars?|pubs?|hof|pojangmacha|caf(?:e|é)s?|coffee|convenience|stores?|shops?|shopping|nightlife|neon|districts?|downtown|evening|night)\b|골목|시장|식당|가게|편의점|카페/i;
/** Review reasons that mean generated lettering, the most frequent rejection of generated images. */
const TEXT_REJECTION=/글자|문자|숫자|간판|텍스트|메뉴|포스터|\b(?:letter\w*|text\w*|signs?|signage|signboards?|writing|numer\w*|words?)\b/i;
const TEXT_FREE_FRAME="The surroundings appear only as softly out-of-focus light and texture. Keep signboards, shopfront fascias, posters, menus, banners, price boards, screens, licence plates and neon lettering entirely outside the frame; do not render any surface that would carry writing.";
/**
 * Composition for one generated candidate. Generated images may not contain any
 * lettering, so the second candidate, a corrective batch and any signage-heavy
 * scene keep the practical subject close instead of repeating a wide street view.
 */
export function imageFraming(slot:number,variant:number,scene:string,corrective:boolean){
 if(!variant && !corrective && !SIGNAGE_SCENE.test(scene))
  return slot%2===0?"Wide editorial overview.":"Detailed editorial view of a different aspect of the topic.";
 return (slot%2===0
  ?"Medium editorial view at eye level from inside the scene: the practical subject (the meal, table, path, seating or object this part of the article is about) fills the foreground."
  :"Close-up editorial detail of the practical subject with shallow depth of field.")+" "+TEXT_FREE_FRAME;
}
/**
 * An explicit operator request for new image candidates. The first request is
 * the original single adaptive batch. Afterwards each request starts a fresh
 * bounded ladder under new receipts, at most OPERATOR_MEDIA_ROUNDS times. A
 * manual replacement hold is released, because the operator is now asking for
 * generated replacements; excluded images stay excluded.
 */
export function planOperatorMediaRound(payload:any,now=new Date().toISOString()){
 if(!payload.photo_retry_revision && !payload.media_manual_hold && !payload.media_round){payload.photo_retry_revision=4;return true;}
 const round=(Number(payload.media_round)||0)+1;
 if(round>OPERATOR_MEDIA_ROUNDS)return false;
 payload.media_round=round;
 delete payload.media_manual_hold;delete payload.photo_retry_revision;delete payload.media_repair;delete payload.media_repairs;
 payload.media_recovery={state:"operator_round",round,at:now};
 return true;
}
/**
 * The corrective scene removes text-prone backgrounds, but it must never forbid
 * the subject the topic is about: a prompt that bans vehicles for a transport
 * comparison is contradictory and the image model returns nothing.
 */
export function recoveryScene(topic:string,reasons:string[],hasEditorialBrief=false){
 const issue=reasons.join(" ");
 const transport=TRANSPORT_TOPIC.test(topic),street=!hasEditorialBrief && STREET_TOPIC.test(topic);
 const constraints=["Preserve high-quality photographic realism: natural light, authentic material textures, depth and a believable South Korean setting. Do not switch to flat icons, cartoons, vector art, silhouettes or featureless abstract shapes. Tighten the camera framing or use natural shallow depth of field to omit text-prone surfaces, rather than deleting the topic or its surroundings."];
 if(hasEditorialBrief)constraints.push("Preserve the supplied article brief, slot goal and time of day; change the composition only as far as needed to remove the rejected details. Do not substitute generic residential alleys or a seated-person portrait.");
 if(TEXT_REJECTION.test(issue))constraints.push("The rejected candidates showed generated lettering on signboards, posters or menus. Recompose closer instead of repeating the wide view: the practical subject fills the frame and every background surface that could carry writing is left outside the frame or dissolved into soft bokeh.");
 if(transport)constraints.push("Keep recognizable subway trains, city buses or taxis as actual vehicles. Crop roof signs, license plates, brand emblems and destination boards outside the frame. Use completely blank surfaces only on small screens or signboards, never flatten the vehicles or replace them with a generic card reader.");
 else if(!street && !hasEditorialBrief)constraints.push("No unrelated vehicles or streets: keep the actual subject in a realistic setting.");
 if(street)constraints.push("Keep recognizable Korean residential streets and architecture, using tiled roofs, stone walls, trees and unmarked residential gates for context. Face away from commercial facades; exclude shops, market stalls, storefronts, billboards and signs entirely. Use realistic textures, perspective and natural lighting; do not replace the neighborhood with blank shapes.");
 if(/hand|finger|face|손|인물|얼굴/i.test(issue))constraints.push(/bow|greeting|respect/i.test(topic)?"Use a wider side view of the Korean greeting with hands naturally outside the frame; retain realistic people and the bow itself.":"Choose a photo composition without people, using the relevant subject and realistic surrounding context, not abstract objects.");
 if(/japan|country|일본|국가|문화/i.test(issue))constraints.push("Use the appropriate South Korean context, avoiding conflicting foreign landmarks.");
 return constraints.join(" ");
}

/** Preserve the latest failed slot; the first recovery may have failed a different slot. */
export function recordMediaResourceWait(payload:any,error:Error){
 const previous=payload.media_recovery || {};
 if(error instanceof ImageCandidatesRejected && payload.media_repair?.slot===error.slot){
  payload.media_repair={...payload.media_repair,state:"rejected"};
  payload.media_repairs={...(payload.media_repairs || {}),[error.slot]:payload.media_repair};
 }
 payload.media_recovery={...previous,state:"needs_resource",reason:error.message,at:new Date().toISOString(),
   ...(error instanceof ImageCandidatesRejected ? {slot:error.slot,reasons:error.reasons.slice(0,2)} : {})};
}

/** One targeted edit after both generation batches failed; never repeat an unknown charge. */
export function planMediaRepair(payload:any,error:unknown,settled:boolean){
 if(!(error instanceof ImageCandidatesRejected)||!settled||!payload.photo_retry_revision||payload.media_repairs?.[error.slot] || (payload.media_repair?.slot===error.slot))return false;
 payload.media_repair={state:"assigned",slot:error.slot,reasons:error.reasons.slice(0,2),at:new Date().toISOString()};
 payload.media_repairs={...(payload.media_repairs || {}),[error.slot]:payload.media_repair};
 payload.media_recovery={...(payload.media_recovery || {}),state:"repairing",slot:error.slot,reasons:error.reasons.slice(0,2),at:new Date().toISOString()};
 return true;
}
