// Short exclusive sections protect a workspace snapshot/restore against every
// in-flight mutation, including requests that write after a network await.
export function workspaceGate(){
  const active=new Set();let locked=null,exclusive=Promise.resolve();
  return {
    async enter(){while(locked)await locked;let done;const promise=new Promise(r=>done=r);active.add(promise);return ()=>{active.delete(promise);done();};},
    exclusive(fn){
      const job=exclusive.catch(()=>{}).then(async()=>{let release;locked=new Promise(r=>release=r);try{await Promise.all([...active]);return await fn();}finally{locked=null;release();}});
      exclusive=job;return job;
    },
  };
}
