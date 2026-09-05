// A synthetic, revision-pinned fixture. It is deliberately not an approval receipt.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha, writeJSON } from '../lib/io.mjs';

const tokens = {
  primary: '#0f766e', onPrimary: '#ffffff', bg: '#f8fafc', surface: '#ffffff',
  text: '#0f172a', muted: '#475569', border: '#cbd5e1',
  fontFamily: "'Pretendard', -apple-system, sans-serif", radius: '12px'
};
const normal = { id: 'default', title: '기본' };
const error = { id: 'error', title: '입력 오류', message: '필수 정보를 확인한 뒤 다시 시도해 주세요. 입력값은 유지됩니다.', tone: 'error' };
const success = { id: 'success', title: '예약 요청 완료', message: '예약 요청을 접수했습니다. 이 데모는 브라우저에만 저장됩니다.', tone: 'success' };
const field = (id, label, type = 'text', value = '', extra = {}) => ({ id, label, type, required: true, value, ...extra });
const action = (id, label, to, kind = 'navigate', extra = {}) => ({ id, label, to, kind, ...extra });
const screen = (id, title, description, prdScreen, sections, actions, states = [normal]) => ({ id, route: `/${id}`, sourceScreenId: id, title, description, prdScreen, sections, actions, states });

export const secondDomainSpec = {
  version: 1,
  id: 'fixture-pet-care-reservation-v1',
  title: '포근한 돌봄',
  language: 'ko',
  system: 'shadcn',
  tokens,
  viewports: [{ id: 'mobile', width: 390, height: 844 }, { id: 'desktop', width: 1280, height: 900 }],
  entryScreen: 'reservation-home',
  components: ['Button', 'Card', 'Field', 'Notice', 'Screen'],
  screens: [
    screen('reservation-home', '반려동물 돌봄을 예약하세요', '가까운 돌봄 서비스를 빠르게 찾을 수 있어요.', 'Service search', [
      { id: 'hero', title: '오늘 필요한 돌봄', body: '산책, 방문 돌봄, 호텔을 한곳에서 비교해 보세요.' },
      { id: 'search', title: '예약 조건', fields: [field('pet-name', '반려동물 이름', 'text', '콩이'), field('service-type', '돌봄 종류', 'select', '방문 돌봄', { options: ['방문 돌봄', '산책', '호텔'] })] }
    ], [action('find-carers', '돌봄 서비스 찾기', 'carer-list', 'submit')], [normal, error]),
    screen('carer-list', '가능한 돌봄 선생님', '조건에 맞는 돌봄 선생님을 골라 주세요.', 'Carer list', [
      { id: 'results', title: '추천 돌봄 선생님', items: [{ id: 'mina', title: '김미나', description: '방문 돌봄 · 후기 4.9' }, { id: 'jun', title: '이준', description: '산책 · 후기 4.8' }] },
      { id: 'filter', title: '방문 시간', fields: [field('visit-date', '희망 날짜', 'date', '2026-11-21')] }
    ], [action('select-carer', '김미나 선생님 선택', 'reservation-form'), action('back-home', '조건 다시 입력', 'reservation-home', 'navigate', { variant: 'secondary' })]),
    screen('reservation-form', '예약 정보를 확인해 주세요', '돌봄 요청을 보내기 전 마지막 확인 단계예요.', 'Reservation form', [
      { id: 'request', title: '돌봄 요청', fields: [field('address', '방문 주소', 'text', '서울시 마포구'), field('care-note', '특이사항', 'textarea', '낯선 사람에게 조금 수줍어해요.')] },
      { id: 'consent', body: '입력한 정보는 이 브라우저에서만 사용하는 데모 데이터입니다.' }
    ], [action('request-reservation', '예약 요청 보내기', 'reservation-complete', 'submit', { targetState: 'success' }), action('back-list', '선생님 다시 선택', 'carer-list', 'navigate', { variant: 'secondary' })], [normal, error]),
    screen('reservation-complete', '예약 요청을 보냈어요', '김미나 선생님이 확인하면 알려드릴게요.', 'Reservation confirmation', [
      { id: 'summary', title: '{{pet-name}}의 방문 돌봄', body: '{{visit-date}} · 서울시 마포구' },
      { id: 'support', body: '실제 결제와 알림 발송은 이 프로토타입에 연결되어 있지 않습니다.' }
    ], [action('view-reservation', '예약 내역 보기', 'reservation-detail'), action('payment-help', '결제 안내', 'reservation-complete', 'unavailable', { capability: 'payments', variant: 'secondary' })], [normal, success]),
    screen('reservation-detail', '예약 내역', '요청한 돌봄 정보를 다시 확인할 수 있어요.', 'Reservation detail', [
      { id: 'status', title: '확인 대기', body: '김미나 선생님이 요청을 검토하고 있어요.' },
      { id: 'details', title: '예약 정보', items: [{ id: 'pet', title: '콩이', description: '방문 돌봄' }, { id: 'time', title: '2026년 11월 21일', description: '오후 2시' }] }
    ], [action('new-reservation', '새 예약 만들기', 'reservation-home'), action('contact-carer', '선생님에게 문의', 'reservation-detail', 'unavailable', { capability: 'messages', variant: 'secondary' })])
  ],
  tasks: [{ id: 'book-pet-care', name: '돌봄 서비스 예약 요청', screenIds: ['reservation-home', 'carer-list', 'reservation-form', 'reservation-complete', 'reservation-detail'], actionIds: ['find-carers', 'select-carer', 'request-reservation', 'view-reservation'] }],
  capabilities: [
    { id: 'storage', status: 'local', description: '입력값은 이 브라우저의 로컬 저장소에만 저장합니다.' },
    { id: 'payments', status: 'unavailable', description: '결제 연동은 이 프로토타입에서 제공하지 않습니다.' },
    { id: 'messages', status: 'unavailable', description: '메시지 연동은 이 프로토타입에서 제공하지 않습니다.' }
  ],
  rationale: ['Synthetic reservation fixture for portability tests; it is not a historical review artifact.', 'The flow uses shared tokens and fields across search, selection, request, and recovery states.']
};

function ref(path, value) { return { path, sha256: sha(value) }; }
function writeText(path, value) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, value); }

/** Creates an isolated fixture below dir and returns only its pinned, portable inputs. */
export function createSecondDomain(dir) {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  const prd = {
    id: secondDomainSpec.id, title: secondDomainSpec.title, domain: 'pet-care-reservation', sampleInput: true,
    problem: '보호자가 신뢰할 수 있는 돌봄 요청을 빠르게 만들 수 있어야 합니다.', targetUsers: ['반려동물 보호자'],
    background: 'Synthetic test fixture only. It does not represent an upstream human approval or production source.',
    coreFlows: [{ id: 'book-pet-care', name: '돌봄 서비스 예약 요청', steps: ['검색', '선생님 선택', '요청 작성', '완료 확인'] }],
    mustHaveScreens: ['Service search', 'Carer list', 'Reservation form', 'Reservation confirmation', 'Reservation detail'],
    viewport: { width: 390, height: 844 }, brandConstraints: { primary: tokens.primary, bg: tokens.bg, surface: tokens.surface, text: tokens.text, fontFamily: tokens.fontFamily }
  };
  const prdText = `${JSON.stringify(prd, null, 2)}\n`;
  writeText(join(root, 'prd.json'), prdText);
  const wireframeHtml = '<main data-fixture="synthetic"><section id="reservation-home">reservation-home</section><section id="carer-list">carer-list</section><section id="reservation-form">reservation-form</section><section id="reservation-complete">reservation-complete</section><section id="reservation-detail">reservation-detail</section></main>\n';
  const conceptHtml = '<main data-fixture="synthetic"><h1>포근한 돌봄</h1><p>예약 서비스 시각 콘셉트</p></main>\n';
  writeText(join(root, 'manifests/wireframe.html'), wireframeHtml);
  writeText(join(root, 'manifests/concept.html'), conceptHtml);
  const wireframeArtifact = ref('manifests/wireframe.html', wireframeHtml);
  const conceptArtifact = ref('manifests/concept.html', conceptHtml);
  const common = { prdId: prd.id, round: 1, viewport: { width: 390, height: 844 }, qualityChecks: [], repairHistory: [], timing: { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', budgetNote: 'synthetic fixture' }, rationaleSummary: 'Synthetic test fixture only; this is not an approval record.' };
  const wireframe = { ...common, laneId: 'wireframe', runId: 'fixture-wireframe-v1', artifacts: [{ id: 'fixture-wireframe', type: 'clickable-wireframe', path: 'wireframe.html', revisionHash: wireframeArtifact.sha256 }], screens: secondDomainSpec.screens.map(({ id, title }) => ({ id: `reservation:${id}`, name: title, purpose: 'Synthetic fixture screen' })) };
  const concept = { ...common, laneId: 'visual-concept', runId: 'fixture-concept-v1', artifacts: [{ id: 'fixture-concept', type: 'concept-screen', path: 'concept.html', revisionHash: conceptArtifact.sha256, conceptId: 'pet-care' }], concepts: [{ id: 'pet-care', name: 'Calm care', direction: 'Synthetic fixture only', differentiation: 'No production concept claim.', tokenOverlay: { ...tokens } }] };
  writeJSON(join(root, 'manifests/wireframe.json'), wireframe);
  writeJSON(join(root, 'manifests/concept.json'), concept);
  const specPath = join(root, 'normalized-spec.json');
  writeJSON(specPath, secondDomainSpec);
  const input = {
    version: 1, root: '.', system: 'shadcn',
    prd: ref('prd.json', prdText), spec: ref('normalized-spec.json', `${JSON.stringify(secondDomainSpec, null, 2)}\n`),
    wireframe: { manifest: null, artifact: wireframeArtifact, artifactId: 'fixture-wireframe', selectedId: 'reservation' },
    concept: { manifest: null, artifact: conceptArtifact, artifactId: 'fixture-concept', selectedId: 'pet-care' },
    scope: { screens: secondDomainSpec.screens.map(({ id, states }) => ({ id, states: states.map(({ id: stateId }) => stateId) })), viewports: secondDomainSpec.viewports },
    brandConstraints: { primary: tokens.primary, bg: tokens.bg, surface: tokens.surface, text: tokens.text, fontFamily: tokens.fontFamily },
    compatibility: { prdHash: sha(prdText), wireframeHash: wireframeArtifact.sha256, conceptHash: conceptArtifact.sha256, representativeScreenId: 'reservation-home', sectionOrder: ['hero', 'search'], basis: 'Synthetic fixture: source structure and visual tokens are explicitly pinned for deterministic portability tests.' },
    approval: { kind: 'user-authorized-scenario', authorization: 'Test fixture authorization: upstream scenario is explicitly assumed for pipeline validation.', assumption: 'Synthetic fixture labels preserve the distinction between an assumption and a historical human receipt.' }
  };
  // Serialize manifests before pinning their exact bytes in the input handoff.
  input.wireframe.manifest = ref('manifests/wireframe.json', readFileSync(join(root, 'manifests/wireframe.json')));
  input.concept.manifest = ref('manifests/concept.json', readFileSync(join(root, 'manifests/concept.json')));
  const inputPath = join(root, 'input.json'); writeJSON(inputPath, input);
  return { inputPath, specPath, spec: structuredClone(secondDomainSpec), root, input };
}
