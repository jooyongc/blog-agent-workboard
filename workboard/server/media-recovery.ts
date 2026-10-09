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
export function recoveryScene(topic:string,reasons:string[]){
 const issue=reasons.join(" ");
 const constraints=["Use a plain studio backdrop or featureless abstract background. No windows, buildings, streets, vehicles, printed materials, signs, menus, text or numbers. Use clean flat shapes and a simple editorial illustration rather than a detailed photograph."];
 if(/hand|finger|face|손|인물|얼굴/i.test(issue))constraints.push(/bow|greeting|respect/i.test(topic)?"Show culturally accurate bowing only as featureless silhouettes; no visible fingers or facial detail.":"Use only topic-specific objects, without people, faces or hands.");
 if(/japan|country|일본|국가|문화/i.test(issue))constraints.push("Use topic-specific South Korean context only; omit all ambiguous landmarks and country-specific architecture.");
 return constraints.join(" ");
}
