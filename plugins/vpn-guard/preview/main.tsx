import {createRoot} from 'react-dom/client';
import {GuardPage} from '../app.js';

const params=new URLSearchParams(location.search);
localStorage.setItem('vpn-guard-language',params.get('lang')==='en'?'en':'ru');
document.documentElement.dataset.theme=params.get('theme')==='dark'?'dark':'light';
const width=Number(params.get('pane'));
if(width>=280&&width<=1600)document.body.style.maxWidth=`${width}px`;
createRoot(document.getElementById('root')!).render(<GuardPage/>);
