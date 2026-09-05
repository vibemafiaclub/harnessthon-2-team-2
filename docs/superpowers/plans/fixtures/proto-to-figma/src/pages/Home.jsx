import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <div>
      <h1>홈</h1>
      <Link to="/list">목록 보기</Link>
    </div>
  )
}
