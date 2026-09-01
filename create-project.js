fetch('http://localhost:3001/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Test Project',
    description: 'Testing with CodeLlama'
  })
})
.then(res => res.json())
.then(data => console.log('Project created:', data))
.catch(err => console.error('Error:', err));