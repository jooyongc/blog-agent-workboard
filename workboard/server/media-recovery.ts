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
 const banned=["windows",...(street?[]:["buildings","streets"]),...(transport?[]:["vehicles"]),"printed materials","signs","menus","text or numbers"];
 const constraints=[`Use a plain studio backdrop or featureless abstract background. No ${banned.join(", ")}. Use clean flat shapes and a simple editorial illustration rather than a detailed photograph.`];
 if(transport)constraints.push("Vehicles appear only as simplified flat-color shapes with completely blank surfaces: no roof lamps, route numbers, destination displays, emblems, logos or license plates.");
 if(street)constraints.push("Buildings and streets appear only as simplified flat shapes with blank facades: no shop signs, banners, house numbers or posters.");
 if(/hand|finger|face|손|인물|얼굴/i.test(issue))constraints.push(/bow|greeting|respect/i.test(topic)?"Show culturally accurate bowing only as featureless silhouettes; no visible fingers or facial detail.":"Use only topic-specific objects, without people, faces or hands.");
 if(/japan|country|일본|국가|문화/i.test(issue))constraints.push("Use topic-specific South Korean context only; omit all ambiguous landmarks and country-specific architecture.");
 return constraints.join(" ");
}
