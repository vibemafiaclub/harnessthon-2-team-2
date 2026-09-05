// Deterministic representative scenario; never a historical approval receipt.
export const tokens = { primary:'#18181b', onPrimary:'#fafafa', bg:'#fafafa', surface:'#ffffff', text:'#09090b', muted:'#71717a', border:'#e4e4e7', fontFamily:"'Inter', 'Pretendard', -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif", radius:'8px' };
const normal = {id:'default',title:'기본'};
const error = {id:'error',title:'입력 오류 / 저장 실패',message:'입력 내용을 확인한 후 다시 시도해 주세요. 작성한 내용은 유지됩니다.',tone:'error'};
const success = {id:'success',title:'완료',message:'정상적으로 저장되었습니다. 이 데모의 데이터는 현재 브라우저에만 보관됩니다.',tone:'success'};
const field = (id,label,type='text',value='',extra={}) => ({id,label,type,required:true,value,...extra});
const action = (id,label,to,kind='navigate',extra={}) => ({id,label,to,kind,...extra});
const screen = (id,title,description,prdScreen,sections,actions,states=[normal]) => ({id,route:`/${id}`,sourceScreenId:id,title,description,prdScreen,sections,actions,states});
export const guestSections = [
  {id:'access',body:'소중한 분들을 초대합니다. 로그인 없이 보실 수 있어요.'},
  {id:'hero',title:'우리의 결혼식 · {{template}}',image:true},
  {id:'names',title:'{{groom}} ♥ {{bride}}, 결혼합니다'},
  {id:'greeting',body:'{{greeting}}'},
  {id:'ceremony',title:'예식 안내',body:'{{date}} · 오후 1시\n{{venue}}'},
  {id:'calendar',title:'기억해 주세요',body:'소중한 약속을 캘린더에 남겨 주세요.'},
  {id:'directions',title:'오시는 길',body:'{{address}}'},
  {id:'map',title:'예식장 위치',body:'지도는 데모 안내입니다. 실제 위치는 예식장 주소로 확인해 주세요.'},
  {id:'address-copy',body:'{{address}}'},
  {id:'transport',title:'교통 안내',body:'지하철 2호선 역삼역 3번 출구에서 도보 5분. 버스 146, 341번 역삼역 하차.'},
  {id:'parking',title:'주차 안내',body:'건물 지하 1~3층 · 2시간 무료. 안내데스크에서 차량 번호를 등록해 주세요.'},
  {id:'transfer',title:'마음 전하실 곳',body:'축하의 마음만으로도 감사합니다. 은행 송금은 이 데모에서 지원하지 않습니다.'}
];
export const weddingSpec = {
  version:1,id:'prd-wedding-invitation-v1',title:'소중한 날',language:'ko',system:'shadcn',tokens,
  viewports:[{id:'mobile',width:390,height:844},{id:'desktop',width:1280,height:900}],entryScreen:'w-template',
  components:['Button','Card','Field','Notice','Screen'],
  screens:[
    screen('w-template','우리의 이야기를 시작해요','1 / 5 · 마음에 드는 청첩장을 골라 주세요.','Template gallery',[
      {id:'templates',title:'오래 간직하고 싶은 초대',items:[{id:'classic',title:'클래식 레터',description:'단정한 서체와 여백으로 전하는 진심'},{id:'gallery',title:'포토 갤러리',description:'같이 걸어온 순간을 담은 초대'},{id:'minimal',title:'심플 모먼트',description:'필요한 정보를 또렷하게 전하는 초대'}],fields:[field('template','청첩장 템플릿','select','클래식 레터',{options:['클래식 레터','포토 갤러리','심플 모먼트']})]}
    ],[action('choose-template','이 템플릿으로 시작','w-info','submit')],[normal,{id:'empty',title:'검색 결과 없음',message:'다른 템플릿을 선택해 주세요.',tone:'info'},error]),
    screen('w-info','두 분의 소식을 알려 주세요','2 / 5 · 하객에게 안내할 기본 정보예요.','Invitation editor',[
      {id:'couple',title:'결혼하는 두 사람',fields:[field('groom','신랑 이름','text','민준'),field('bride','신부 이름','text','서연')]},
      {id:'event',title:'예식 일시와 장소',fields:[field('date','예식 날짜','date','2026-10-24'),field('venue','예식장','text','그랜드 웨딩홀 3층'),field('address','주소','text','서울시 강남구 테헤란로 123')]}
    ],[action('save-info','사진과 인사말로','w-media','submit'),action('back-template','이전 단계','w-template','navigate',{variant:'secondary'})],[normal,error]),
    screen('w-media','우리다운 인사를 전해요','3 / 5 · 사진과 인사말을 꾸며 주세요.','Invitation editor',[
      {id:'photo',title:'대표 사진',image:true,fields:[field('photo','사진 추가','file','',{required:false})]},
      {id:'message',title:'초대의 글',fields:[field('greeting','인사말','textarea','저희 두 사람이 사랑과 믿음으로 한 가정을 이루게 되었습니다. 귀한 걸음으로 축복해 주세요.')]}
    ],[action('preview','하객 화면 미리보기','w-preview','submit'),action('back-info','이전 단계','w-info','navigate',{variant:'secondary'})],[normal,error]),
    screen('w-preview','초대장을 확인해 주세요','4 / 5 · 하객에게 보일 내용을 마지막으로 확인해 주세요.',undefined,guestSections,
      [action('publish','청첩장 발행하기','w-publish','submit',{targetState:'success'}),action('edit','내용 수정하기','w-info','navigate',{variant:'secondary'})],[normal,error]),
    screen('w-publish','초대장이 준비되었어요','5 / 5 · 링크를 복사해 소중한 분께 전해 주세요.',undefined,
      [{id:'published',title:'{{groom}} ♥ {{bride}}의 결혼식',body:'링크는 현재 로컬 미리보기 주소입니다. 외부 공개 발행은 하지 않습니다.'}],
      [action('copy-link','초대장 링크 복사','w-guest','copy'),action('open-guest','하객 화면 열기','w-guest'),action('edit-published','내용 수정','w-info','navigate',{variant:'secondary'})],[normal,success]),
    screen('w-guest','{{groom}} ♥ {{bride}}의 결혼식','{{date}} · 오후 1시','Guest invitation page',guestSections,
      [action('rsvp','참석 여부 회신','w-rsvp'),action('calendar','캘린더 안내','w-guest','unavailable',{sectionId:'calendar',capability:'calendar',variant:'secondary'}),action('copy-address','주소 복사','w-guest','copy',{sectionId:'address-copy',variant:'secondary'}),action('bank','송금 안내','w-guest','unavailable',{sectionId:'transfer',capability:'bank',variant:'secondary'})],[normal]),
    screen('w-rsvp','함께해 주실 수 있나요?','원활한 예식 준비를 위해 참석 여부를 알려 주세요.','RSVP form',[
      {id:'reply',title:'참석 정보',fields:[field('guestName','성함'),field('attendance','참석 여부','select','참석',{options:['참석','불참']}),field('headcount','총 참석 인원','number','1',{min:1,visibleWhen:{field:'attendance',equals:'참석'}}),field('meal','식사 여부','select','식사 예정',{options:['식사 예정','식사 안 함'],visibleWhen:{field:'attendance',equals:'참석'}})]},
      {id:'privacy',body:'입력 정보는 예식 준비를 위한 데모이며, 이 브라우저에만 저장됩니다.'}
    ],[action('submit-rsvp','회신 보내기','w-rsvp','submit',{targetState:'success'}),action('return-invite','초대장으로 돌아가기','w-guest','navigate',{variant:'secondary'})],[normal,error,{...success,title:'회신 완료',message:'회신을 전달했어요. 함께해 주셔서 감사합니다.'}])
  ],
  tasks:[{id:'flow-build',name:'청첩장 만들고 공유하기',screenIds:['w-template','w-info','w-media','w-preview','w-publish','w-guest'],actionIds:['choose-template','save-info','preview','publish','open-guest']},{id:'flow-guest',name:'하객이 참석 의사 전달하기',screenIds:['w-guest','w-rsvp','w-rsvp','w-guest'],actionIds:['rsvp','submit-rsvp','return-invite']}],
  capabilities:[{id:'storage',status:'local',description:'폼과 회신을 현재 브라우저에 저장합니다.'},{id:'publish',status:'mock',description:'발행은 로컬 프로토타입 상태 변경입니다. 외부 공개되지 않습니다.'},{id:'calendar',status:'unavailable',description:'캘린더 연동은 연결되지 않았습니다. 예식 일시를 직접 등록해 주세요.'},{id:'bank',status:'unavailable',description:'실제 송금과 은행 앱 연결은 지원하지 않습니다.'}],
  rationale:['The wizard structure and shadcn concept are pinned to committed r3 examples. Approval is a user-authorized scenario assumption, not a historical receipt.','The selected representative section order is retained. Additional builder screens reuse the same tokens and controls.','System font fallbacks are intentional; no remote font is promised. Maps, publishing and external integrations are declared frontend-only capabilities.']
};
