import { Link } from 'react-router-dom'

export default function List() {
  return (
    <div>
      <h1>목록</h1>
      <Link to="/list/1">항목 1 상세</Link>
    </div>
  )
}
