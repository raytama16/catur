import { redirect } from 'next/navigation';
import GameRoom from '../../../components/GameRoom';
import { isValidRoomCode } from '../../../lib/protocol';

export const dynamic = 'force-dynamic';

export default function RoomPage({ params, searchParams }: { params: { code: string }; searchParams?: { seat?: string } }) {
  const code = String(params.code || '').toLowerCase();
  if (!isValidRoomCode(code)) redirect('/');
  const preferSide = searchParams?.seat === 'w' ? 'w' : 'auto';
  return <GameRoom code={code} preferSide={preferSide} />;
}
