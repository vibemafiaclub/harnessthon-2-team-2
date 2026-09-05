import { useParams } from 'react-router-dom'

export default function Detail() {
  const { id } = useParams()
  return (
    <div>
      <h1>상세 {id}</h1>
    </div>
  )
}
