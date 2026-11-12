export function mountKakaoChannel(root:HTMLElement,options:Record<string,unknown>):{
 configure(config:unknown):void|Promise<void>|null;
 updateContext(context:unknown):void;
 destroy():void;
};
