# SSH keys for build and storage computers

In Settings → Computers, connect the computer and open its capabilities. Select the Business OS that owns the computer, then choose Build or Storage and enter its SSH host, username, directory and verified host-key fingerprint.

Choose **Create a key in the selected Business OS** when it does not already have an SSH credential for this computer. Save the computer. After confirmation, Workjet displays the public SSH key and its fingerprint. Authorize that public key for the selected account on the target computer, then click **Done**. The private key stays in that Business OS's encrypted Secret Store.

Choose **Use an existing saved key** to supply the group and name of an existing native credential. A key held by the Mac is not automatically a credential in a remote Business OS.

An interrupted save can be retried. The same owner and computer reuse the native key. Computer and endpoint registration are confirmed separately. If a step fails, the editor keeps its input and explains which confirmation remains outstanding. Registration alone does not establish SSH connectivity or reserve a build slot.
