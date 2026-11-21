import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 함렛(Hahmlet) 가변 글꼴. 방장 PC 서버가 글꼴 파일도 함께 제공하므로 인터넷 없이도 보인다.
import '@fontsource-variable/hahmlet';
import './styles.css';
import './game.css';
import { preloadCardArt } from './ui/art';

// 카드·버튼 그림(작은 webp 13장)을 미리 받아 둔다.
preloadCardArt();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
