import React from 'react';
import type {MachineMark} from './machine-marks';

type Shape={tag:'path'|'rect'|'circle';attrs:Record<string,string>};
const screen:Shape={tag:'rect',attrs:{x:'4',y:'4',width:'16',height:'12',rx:'1.5',fill:'currentColor',fillOpacity:'.3'}};
const shapes:Record<MachineMark['icon'],Shape[]>={
 laptop:[{tag:'rect',attrs:{x:'5',y:'4',width:'14',height:'11',rx:'1.5',fill:'currentColor',fillOpacity:'.3'}},{tag:'path',attrs:{d:'M5 15 2 19h20l-3-4M9 19h6'}}],
 server:[{tag:'rect',attrs:{x:'4',y:'3',width:'16',height:'18',rx:'2',fill:'currentColor',fillOpacity:'.16'}},{tag:'path',attrs:{d:'M4 9h16M4 15h16M11 6h6M11 12h6M11 18h6'}},{tag:'circle',attrs:{cx:'7',cy:'6',r:'.65',fill:'currentColor'}},{tag:'circle',attrs:{cx:'7',cy:'12',r:'.65',fill:'currentColor'}},{tag:'circle',attrs:{cx:'7',cy:'18',r:'.65',fill:'currentColor'}}],
 cloud:[{tag:'path',attrs:{d:'M7 18h11a4 4 0 0 0 .4-8A6.5 6.5 0 0 0 6 8.4 4.8 4.8 0 0 0 7 18Z',fill:'currentColor',fillOpacity:'.22'}}],
 desktop:[screen,{tag:'path',attrs:{d:'M12 16v4M8 20h8'}}],
 terminal:[screen,{tag:'path',attrs:{d:'m7 8 3 2-3 2m6 0h4'}}],
 globe:[{tag:'circle',attrs:{cx:'12',cy:'12',r:'9',fill:'currentColor',fillOpacity:'.12'}},{tag:'path',attrs:{d:'M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z'}}],
 chip:[{tag:'rect',attrs:{x:'6',y:'6',width:'12',height:'12',rx:'2',fill:'currentColor',fillOpacity:'.28'}},{tag:'path',attrs:{d:'M9 3v3m6-3v3m-6 12v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3'}}],
 database:[{tag:'path',attrs:{d:'M4 6c0-4 16-4 16 0v12c0 4-16 4-16 0ZM4 6c0 4 16 4 16 0M4 12c0 4 16 4 16 0',fill:'currentColor',fillOpacity:'.16'}}]
};
export function MachineGlyph({icon}:{icon:MachineMark['icon']}) {
 return <svg data-machine-glyph={icon} aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{display:'block',flexShrink:0}}>{shapes[icon].map((shape,i)=>React.createElement(shape.tag,{...shape.attrs,key:i}))}</svg>;
}
export function createMachineGlyph(doc:Document,icon:MachineMark['icon']) {
 const ns='http://www.w3.org/2000/svg';const svg=doc.createElementNS(ns,'svg');
 for(const [key,value] of Object.entries({'data-machine-glyph':icon,'aria-hidden':'true',viewBox:'0 0 24 24',width:'16',height:'16',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round'}))svg.setAttribute(key,value);
 svg.style.display='block';
 for(const shape of shapes[icon]){const node=doc.createElementNS(ns,shape.tag);for(const [key,value] of Object.entries(shape.attrs))node.setAttribute(key==='fillOpacity'?'fill-opacity':key,value);svg.append(node);}
 return svg;
}
