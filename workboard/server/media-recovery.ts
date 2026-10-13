import {HttpError} from "./http";
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
/**
 * The corrective scene removes text-prone backgrounds, but it must never forbid
 * the subject the topic is about: a prompt that bans vehicles for a transport
 * comparison is contradictory and the image model returns nothing.
 */
export function recoveryScene(topic:string,reasons:string[]){
 const issue=reasons.join(" ");
 const transport=TRANSPORT_TOPIC.test(topic),street=STREET_TOPIC.test(topic);
 const constraints=["Preserve high-quality photographic realism: natural light, authentic material textures, depth and a believable South Korean setting. Do not switch to flat icons, cartoons, vector art, silhouettes or featureless abstract shapes. Tighten the camera framing or use natural shallow depth of field to omit text-prone surfaces, rather than deleting the topic or its surroundings."];
 if(transport)constraints.push("Keep recognizable subway trains, city buses or taxis as actual vehicles. Crop roof signs, license plates, brand emblems and destination boards outside the frame. Use completely blank surfaces only on small screens or signboards, never flatten the vehicles or replace them with a generic card reader.");
 else if(!street)constraints.push("No unrelated vehicles or streets: keep the actual subject in a realistic setting.");
 if(street)constraints.push("Keep recognizable Korean streets and architecture, with blank facades only where a text panel would appear; use realistic textures, perspective and natural lighting.");
 if(/hand|finger|face|손|인물|얼굴/i.test(issue))constraints.push(/bow|greeting|respect/i.test(topic)?"Use a wider side view of the Korean greeting with hands naturally outside the frame; retain realistic people and the bow itself.":"Choose a photo composition without people, using the relevant subject and realistic surrounding context, not abstract objects.");
 if(/japan|country|일본|국가|문화/i.test(issue))constraints.push("Use the appropriate South Korean context, avoiding conflicting foreign landmarks.");
 return constraints.join(" ");
}
